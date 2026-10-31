/**
 * data/.lock: one writer per folder, also across computers sharing a
 * network folder. A heartbeat keeps it fresh; a lock without heartbeat for
 * two minutes belongs to a crashed instance and can be taken over.
 */
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { errorCode, JobError } from './errors'
import { atomicWrite } from './fsx'
import { LOCK_FILE } from './manifest'

export interface LockInfo {
  host: string
  pid: number
  instance_id: string
  project_id: string
  started_at: string
  heartbeat_at: string
}

export interface LockOptions {
  instance_id: string
  project_id: string
  stale_ms?: number
  heartbeat_ms?: number
  now?: () => number
}

export const LOCK_STALE_MS = 120_000
export const LOCK_HEARTBEAT_MS = 30_000

export async function readLock(
  data_dir: string,
): Promise<LockInfo | undefined> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(data_dir, LOCK_FILE), 'utf8'),
    ) as LockInfo
  } catch {
    return undefined
  }
}

export function isStale(
  info: LockInfo,
  now: number,
  stale_ms = LOCK_STALE_MS,
): boolean {
  const beat = Date.parse(info.heartbeat_at)
  return !Number.isFinite(beat) || now - beat > stale_ms
}

export class FolderLock {
  private timer?: NodeJS.Timeout
  private info: LockInfo
  /** Set when another instance took the folder while we were working */
  lost = false

  private constructor(
    private file: string,
    info: LockInfo,
    private options: Required<LockOptions>,
  ) {
    this.info = info
  }

  static async acquire(
    data_dir: string,
    options: LockOptions,
  ): Promise<FolderLock> {
    // `??`, not a spread: an option passed as undefined must keep the default
    // (setInterval with undefined runs every millisecond)
    const opts: Required<LockOptions> = {
      instance_id: options.instance_id,
      project_id: options.project_id,
      stale_ms: options.stale_ms ?? LOCK_STALE_MS,
      heartbeat_ms: Math.max(10, options.heartbeat_ms ?? LOCK_HEARTBEAT_MS),
      now: options.now ?? Date.now,
    }
    const file = path.join(data_dir, LOCK_FILE)
    const now = new Date(opts.now()).toISOString()
    const info: LockInfo = {
      host: os.hostname(),
      pid: process.pid,
      instance_id: opts.instance_id,
      project_id: opts.project_id,
      started_at: now,
      heartbeat_at: now,
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // wx: fails when the file exists, also over SMB (CREATE_NEW)
        await fs.writeFile(file, JSON.stringify(info), { flag: 'wx' })
        const lock = new FolderLock(file, info, opts)
        lock.startHeartbeat()
        return lock
      } catch (error) {
        if (errorCode(error) != 'EEXIST') throw error
      }
      const current = await readLock(data_dir)
      const ours =
        current?.instance_id == opts.instance_id &&
        current?.project_id == opts.project_id
      if (current && !ours && !isStale(current, opts.now(), opts.stale_ms)) {
        throw new JobError(
          'folder_locked',
          'Another instance is syncing this folder',
          `${current.host} (pid ${current.pid})`,
        )
      }
      // Ours from an earlier job, stale, or unreadable: take it over
      await fs.rm(file, { force: true })
    }
    throw new JobError('folder_locked', 'The folder lock could not be taken')
  }

  private startHeartbeat(): void {
    this.timer = setInterval(() => void this.beat(), this.options.heartbeat_ms)
    this.timer.unref?.()
  }

  private async beat(): Promise<void> {
    try {
      const current = await readLock(path.dirname(this.file))
      if (current && current.instance_id != this.info.instance_id) {
        this.lost = true
        this.stopHeartbeat()
        return
      }
      this.info = {
        ...this.info,
        heartbeat_at: new Date(this.options.now()).toISOString(),
      }
      await atomicWrite(this.file, JSON.stringify(this.info))
      // Someone may have written between our read and our write: check again
      const after = await readLock(path.dirname(this.file))
      if (after && after.instance_id != this.info.instance_id) {
        this.lost = true
        this.stopHeartbeat()
      }
    } catch {
      // A missed beat is not fatal: the next one retries
    }
  }

  private stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async release(): Promise<void> {
    this.stopHeartbeat()
    if (this.lost) return
    try {
      const current = await readLock(path.dirname(this.file))
      if (!current || current.instance_id == this.info.instance_id) {
        await fs.rm(this.file, { force: true })
      }
    } catch {
      // The folder may be gone: nothing to release
    }
  }
}
