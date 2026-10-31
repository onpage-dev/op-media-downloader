/**
 * A job's hold on its project folder: the checks before the first write, the
 * lock, the manifest, the scan and the plan, the guard that stops every write
 * once the lock is lost, the final save of the manifest and the release.
 */
import { promises as fs } from 'fs'
import path from 'path'
import { ProjectId } from '../shared/models'
import { dataDirOwner } from './data-dir'
import { AbortedError, errorDetail, folderJobError, JobError } from './errors'
import { isInside, isProtectedPath, normalize } from './folder-inspect'
import { freeSpace, pathExists, reachable, unlinkQuiet } from './fsx'
import { sleep } from './http'
import { Job, LogLevel } from './job'
import { FolderLock } from './lock'
import { DATA_DIR, Manifest } from './manifest'
import {
  AdoptionStat,
  adoptionCandidates,
  buildPlan,
  Plan,
  PlanInput,
} from './plan'
import { runQueue } from './queue'
import { scanFolder } from './scan'

export interface SessionOptions {
  /** The folders of all projects: none may be inside another */
  project_folders: { id: ProjectId; folder: string }[]
  instance_id: string
  reach_timeout_ms: number
  lock_stale_ms?: number
  lock_heartbeat_ms?: number
  log: (level: LogLevel, message: string) => void
}

/** File system calls at a time for stats and leftovers: a share answers each one slowly */
const FS_LANES = 8

function lockLost(): JobError {
  return new JobError('folder_locked', 'Another computer took over the folder')
}

/** A file system error as the job's issue, when it is one */
function asJobError(error: unknown): never {
  throw folderJobError(error) ?? error
}

export class FolderSession {
  private constructor(
    readonly folder: string,
    readonly data_dir: string,
    readonly manifest: Manifest,
    private lock: FolderLock,
  ) {}

  /**
   * Folder checks, the lock and the manifest. A lock lost later fails the
   * job at once: the transfers in flight stop, nothing more is written.
   */
  static async open(job: Job, options: SessionOptions): Promise<FolderSession> {
    const project = job.project
    const folder = normalize(project.folder)
    if (isProtectedPath(folder)) {
      throw new JobError(
        'folder_protected',
        'This folder cannot be used',
        folder,
      )
    }
    const other = options.project_folders.find(
      f =>
        f.id != project.id &&
        (isInside(folder, f.folder) || isInside(f.folder, folder)),
    )
    if (other)
      throw new JobError(
        'folder_protected',
        'The folder is used by another project',
        other.id,
      )
    const root =
      /^\\\\[^\\]+\\[^\\]+/.exec(folder)?.[0] ?? path.parse(folder).root
    if (!(await reachable(root, options.reach_timeout_ms, job.signal))) {
      throw new JobError(
        'folder_unreachable',
        'The folder cannot be reached',
        root,
      )
    }
    job.check()
    const data_dir = path.join(folder, DATA_DIR)
    const owner = await dataDirOwner(data_dir).catch(asJobError)
    if (owner == 'foreign') {
      throw new JobError(
        'folder_protected',
        'The folder already has a "data" folder that the app did not create',
        data_dir,
      )
    }
    try {
      await fs.mkdir(data_dir, { recursive: true })
    } catch (error) {
      if (
        !(await pathExists(folder)) &&
        !(await pathExists(path.dirname(folder)))
      ) {
        throw new JobError(
          'folder_unreachable',
          'The folder cannot be reached',
          errorDetail(error),
        )
      }
      throw new JobError(
        'folder_not_writable',
        'The folder cannot be written',
        errorDetail(error),
      )
    }
    const lock = await FolderLock.acquire(data_dir, {
      instance_id: options.instance_id,
      project_id: project.id,
      stale_ms: options.lock_stale_ms,
      heartbeat_ms: options.lock_heartbeat_ms,
      signal: job.signal,
    }).catch(asJobError)
    try {
      job.check()
      const { manifest, source, recovered } = await Manifest.load(
        data_dir,
        project.id,
      ).catch(asJobError)
      if (source == 'link.json')
        options.log('info', 'Imported data/link.json from 1.x')
      if (recovered)
        options.log('warn', 'data/manifest.json was unreadable: rebuilt')
      const session = new FolderSession(folder, data_dir, manifest, lock)
      if (lock.lost) job.fail(lockLost())
      lock.signal.addEventListener('abort', () => job.fail(lockLost()), {
        once: true,
      })
      return session
    } catch (error) {
      await lock.release()
      throw error
    }
  }

  /** Throws once the folder is not the job's to write: another computer took it */
  guard(): void {
    if (this.lock.lost) throw lockLost()
  }

  /** Scan, adoption checks, plan */
  async plan(
    input: Omit<PlanInput, 'manifest' | 'scan' | 'adoption'>,
    signal: AbortSignal,
  ): Promise<Plan> {
    const scan = await scanFolder(this.folder).catch(asJobError)
    // Leftovers of interrupted runs: ours by name
    const leftovers = [
      ...scan.data_leftovers.map(n => path.join(this.data_dir, n)),
      ...scan.folder_leftovers.map(n => path.join(this.folder, n)),
    ]
    await runQueue(leftovers, FS_LANES, async file => {
      await unlinkQuiet(file).catch(() => undefined)
    })
    const candidates = adoptionCandidates(input.desired, this.manifest, scan)
    const adoption = new Map<string, AdoptionStat>()
    await runQueue(
      candidates,
      FS_LANES,
      async candidate => {
        const stat: AdoptionStat = {}
        try {
          const s = await fs.stat(path.join(this.folder, candidate.name), {
            bigint: true,
          })
          stat.name_ino = s.ino
          stat.name_size = Number(s.size)
        } catch {
          // gone: the plan sees it as a free name next time
        }
        if (scan.data_tokens.has(candidate.token)) {
          try {
            stat.blob_ino = (
              await fs.stat(path.join(this.data_dir, candidate.token), {
                bigint: true,
              })
            ).ino
          } catch {
            // no blob: only the size can tell
          }
        }
        adoption.set(candidate.key, stat)
      },
      signal,
    )
    if (signal.aborted) throw new AbortedError()
    return buildPlan({ ...input, manifest: this.manifest, scan, adoption })
  }

  /**
   * Before downloading: the contents, and the copies where the folder copies,
   * must fit. A clear «disk full» now beats a disk filled to the last byte;
   * a file system that does not tell its free space is not checked.
   */
  async checkRoom(plan: Plan, copies: boolean): Promise<void> {
    const contents = plan.downloads.reduce((sum, t) => sum + (t.size ?? 0), 0)
    if (!contents) return
    const copied = copies
      ? plan.downloads.reduce(
          (sum, t) => sum + (t.size ?? 0) * t.names.length,
          0,
        ) + plan.links.reduce((sum, l) => sum + (l.size ?? 0), 0)
      : 0
    const needed = contents + copied
    const free = await freeSpace(this.folder)
    if (free !== undefined && free > 0 && free < needed) {
      throw new JobError(
        'disk_full',
        'Not enough free space',
        `${needed} bytes needed, ${free} free`,
      )
    }
  }

  /**
   * The final save of the manifest, retried: a busy share or an antivirus can
   * refuse it for a moment. Never once the lock is lost: the registry is the
   * new owner's. The error, when it could not be saved.
   */
  async save(): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        this.guard()
      } catch {
        return undefined
      }
      try {
        await this.manifest.flush()
        return undefined
      } catch (error) {
        if (attempt >= 3) return error
        await sleep(500 * attempt)
      }
    }
  }

  /** Frees the folder: the lock goes, and data/ too when a first job left it empty */
  async close(): Promise<void> {
    await this.lock.release()
    await fs.rmdir(this.data_dir).catch(() => undefined)
  }
}
