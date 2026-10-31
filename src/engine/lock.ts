/**
 * data/.lock: one writer per folder, also across computers sharing a
 * network folder. A heartbeat keeps it fresh; a lock without heartbeat for
 * two minutes belongs to a crashed instance and can be taken over. The
 * clocks of two computers can differ by minutes: before taking a lock that
 * looks stale the app watches it for a heartbeat, and a lock of this
 * computer whose process is gone is taken at once. A lock that is lost later
 * (taken by another instance, or not refreshed for most of the stale time)
 * says so through `signal`: the job ends and stops writing.
 */
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { errorCode, isNotFound, JobError } from './errors'
import { atomicWrite } from './fsx'
import { sleep } from './http'
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
  /** How long a lock that looks stale is watched for a heartbeat before it is taken */
  confirm_ms?: number
  now?: () => number
  /** The job's: a stop ends the wait for a lock that looks stale */
  signal?: AbortSignal
}

type Settings = Required<Omit<LockOptions, 'signal'>> & { signal?: AbortSignal }

export const LOCK_STALE_MS = 120_000
export const LOCK_HEARTBEAT_MS = 30_000

export async function readLock(
  data_dir: string,
): Promise<LockInfo | undefined> {
  return (await readLockFile(path.join(data_dir, LOCK_FILE))).info
}

/** `exists` without `info`: a lock being written, or broken */
async function readLockFile(
  file: string,
): Promise<{ exists: boolean; info?: LockInfo }> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    return { exists: !isNotFound(error) }
  }
  try {
    const info = JSON.parse(text) as LockInfo
    return {
      exists: true,
      info: info && typeof info.instance_id == 'string' ? info : undefined,
    }
  } catch {
    return { exists: true }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) == 'EPERM'
  }
}

/** A lock of this computer whose process is gone: the app crashed, no need to wait */
function crashedHere(info: LockInfo): boolean {
  return (
    info.host == os.hostname() &&
    Number.isInteger(info.pid) &&
    info.pid != process.pid &&
    !processAlive(info.pid)
  )
}

/** Whether the lock in the folder can be taken over; otherwise who holds it */
async function takeOver(
  file: string,
  opts: Settings,
): Promise<{ take: boolean; holder?: LockInfo }> {
  const first = await readLockFile(file)
  if (!first.exists) return { take: true }
  const held = first.info
  if (held) {
    // Ours from an earlier job
    if (held.instance_id == opts.instance_id && held.project_id == opts.project_id)
      return { take: true }
    if (crashedHere(held)) return { take: true }
    if (!isStale(held, opts.now(), opts.stale_ms)) return { take: false, holder: held }
  }
  // Stale by its own clock, or unreadable: a live instance beats (or finishes writing) meanwhile
  await sleep(held ? opts.confirm_ms : Math.min(opts.confirm_ms, 2000), opts.signal)
  const second = await readLockFile(file)
  if (!second.exists) return { take: true }
  if (JSON.stringify(second.info) != JSON.stringify(held))
    return { take: false, holder: second.info ?? held }
  return { take: true }
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
  private last_beat: number
  private beating?: Promise<void>
  private lost_controller = new AbortController()
  /**
   * Aborted when another instance took the folder while we were working, or
   * when the heartbeat could not be written for so long that others may take it
   */
  readonly signal = this.lost_controller.signal

  private constructor(
    private file: string,
    info: LockInfo,
    private options: Settings,
  ) {
    this.info = info
    this.last_beat = options.now()
  }

  get lost(): boolean {
    return this.signal.aborted
  }

  static async acquire(
    data_dir: string,
    options: LockOptions,
  ): Promise<FolderLock> {
    // `??`, not a spread: an option passed as undefined must keep the default
    // (setInterval with undefined runs every millisecond)
    const heartbeat_ms = Math.max(10, options.heartbeat_ms ?? LOCK_HEARTBEAT_MS)
    const opts: Settings = {
      instance_id: options.instance_id,
      project_id: options.project_id,
      stale_ms: options.stale_ms ?? LOCK_STALE_MS,
      heartbeat_ms,
      confirm_ms: options.confirm_ms ?? heartbeat_ms + 5000,
      now: options.now ?? Date.now,
      signal: options.signal,
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
      const { take, holder } = await takeOver(file, opts)
      if (!take) {
        throw new JobError(
          'folder_locked',
          'Another instance is syncing this folder',
          holder ? `${holder.host} (pid ${holder.pid})` : undefined,
        )
      }
      await fs.rm(file, { force: true })
    }
    throw new JobError('folder_locked', 'The folder lock could not be taken')
  }

  private startHeartbeat(): void {
    this.timer = setInterval(() => {
      // One beat at a time: a slow share must not pile them up
      this.beating ??= this.beat().finally(() => (this.beating = undefined))
    }, this.options.heartbeat_ms)
    this.timer.unref?.()
  }

  private lose(): void {
    this.stopHeartbeat()
    this.lost_controller.abort()
  }

  private async beat(): Promise<void> {
    try {
      const current = await readLock(path.dirname(this.file))
      if (current && current.instance_id != this.info.instance_id) {
        this.lose()
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
        this.lose()
        return
      }
      this.last_beat = this.options.now()
    } catch {
      // A missed beat is not fatal, the next one retries; but after most of
      // the stale time without one, another computer may take the folder
      if (this.options.now() - this.last_beat > this.options.stale_ms * 0.75)
        this.lose()
    }
  }

  private stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async release(): Promise<void> {
    this.stopHeartbeat()
    // A beat in flight would write the lock again after it is gone
    await this.beating
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
