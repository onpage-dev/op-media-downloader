/**
 * Small asynchronous file system helpers. Nothing here is synchronous: on a
 * network folder every call is a round trip to the server.
 */
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import path from 'path'
import { errorCode, isNotFound } from './errors'
import { sleep } from './http'

/**
 * Locks that go away on their own: an antivirus, the indexer or a sync client
 * holding a new file for a moment. On Windows they show up as EBUSY, EPERM
 * or EACCES; elsewhere EPERM and EACCES are real permissions, never retried.
 */
const TRANSIENT =
  process.platform == 'win32' ? new Set(['EBUSY', 'EPERM', 'EACCES']) : new Set(['EBUSY'])

export function isTransientLock(error: unknown): boolean {
  return TRANSIENT.has(errorCode(error) ?? '')
}

/** Runs `operation`, retrying transient locks: `tries` attempts, 100 ms doubling up to 1 s */
export async function withLockRetry<T>(operation: () => Promise<T>, tries: number): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (!isTransientLock(error) || attempt >= tries) throw error
      await sleep(Math.min(1000, 100 * 2 ** (attempt - 1)))
    }
  }
}

/**
 * Renames, retrying the transient Windows locks that make a rename fail for
 * a moment. On a network share the antivirus can hold a new file for
 * seconds: 10 tries over ~8 s.
 */
export async function renameWithRetry(from: string, to: string, tries = 10): Promise<void> {
  await withLockRetry(() => fs.rename(from, to), tries)
}

/** Writes all of `data`: a write can take fewer bytes than given */
export async function writeAll(handle: FileHandle, data: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < data.byteLength) {
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset)
    if (bytesWritten <= 0) throw Object.assign(new Error('The disk took no bytes'), { code: 'EIO' })
    offset += bytesWritten
  }
}

/** File systems and shares that cannot flush say so this way: not an error of the data */
const NO_FLUSH = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EISDIR', 'EBADF', 'EPERM'])

/**
 * Asks the disk to keep what was written before the file gets its name: after
 * a power cut or an unplugged disk a name never points to half a file. A
 * file system that cannot flush is not an error; a failed flush (EIO) is.
 */
export async function flushToDisk(handle: FileHandle): Promise<void> {
  try {
    await handle.sync()
  } catch (error) {
    if (!NO_FLUSH.has(errorCode(error) ?? '')) throw error
  }
}

/** Flushes a file that is already written and closed (a copy) */
export async function flushFile(file: string): Promise<void> {
  const handle = await fs.open(file, 'r+')
  try {
    await flushToDisk(handle)
  } finally {
    await handle.close()
  }
}

/** Writes a sibling temporary file, flushed, then renames it over the target */
export async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  try {
    const handle = await fs.open(temp, 'w')
    try {
      await writeAll(handle, typeof data == 'string' ? Buffer.from(data) : data)
      await flushToDisk(handle)
    } finally {
      await handle.close()
    }
    await renameWithRetry(temp, file)
  } catch (error) {
    // The cause is the write, not the clean-up
    await unlinkQuiet(temp).catch(() => undefined)
    throw error
  }
}

/** Removes a file; a file that is already gone is fine */
export async function unlinkQuiet(file: string): Promise<boolean> {
  try {
    await fs.unlink(file)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

/** Removes a file, retrying transient locks (an antivirus scanning it): 4 tries over ~0.7 s */
export async function unlinkWithRetry(file: string): Promise<boolean> {
  return withLockRetry(() => unlinkQuiet(file), 4)
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/**
 * Does the path answer within `ms`? A share whose server is gone can keep a
 * stat waiting ~20 s (TCP connect timeout on Windows): we stop waiting
 * earlier (the call itself finishes in the background).
 */
export async function reachable(file: string, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([
      fs.stat(file).then(
        () => true,
        () => false,
      ),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function isDirectory(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isDirectory()
  } catch {
    return false
  }
}

/** Free bytes for this user (quotas included on Windows); undefined when the file system does not say */
export async function freeSpace(dir: string): Promise<number | undefined> {
  try {
    const stats = await fs.statfs(dir)
    const free = stats.bavail * stats.bsize
    return Number.isFinite(free) && stats.blocks > 0 ? free : undefined
  } catch {
    return undefined
  }
}
