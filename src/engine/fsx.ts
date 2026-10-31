/**
 * Small asynchronous file system helpers. Nothing here is synchronous: on a
 * network folder every call is a round trip to the server.
 */
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { errorCode, isNotFound } from './errors'
import { sleep } from './http'

const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Renames, retrying the transient Windows locks (antivirus, indexer, sync
 * clients) that make a rename fail for a moment. On a network share the
 * antivirus can hold a new file for seconds: 10 tries over ~8 s.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  tries = 10,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      if (!TRANSIENT.has(errorCode(error) ?? '') || attempt >= tries)
        throw error
      await sleep(Math.min(1000, 100 * 2 ** (attempt - 1)))
    }
  }
}

/** Writes a sibling temporary file, then renames it over the target */
export async function atomicWrite(
  file: string,
  data: string | Buffer,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  try {
    await fs.writeFile(temp, data)
    await renameWithRetry(temp, file)
  } catch (error) {
    await unlinkQuiet(temp)
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
