/**
 * One file from the storage to data/<token>: stream to a temporary
 * `<token>.<random>.download` (a leftover another program still holds never
 * blocks a new attempt) with a timeout before the first byte and between
 * chunks, check the size, flush it to the disk, then rename (retrying
 * transient Windows locks). Nothing is left behind on error, the connection
 * neither: a disk that refuses a write closes it at once. Errors of the disk
 * work are DiskErrors, never retried as network ones.
 */
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import { AbortedError, DiskError, HttpError, SizeMismatchError, TimeoutError } from './errors'
import { flushToDisk, renameWithRetry, unlinkQuiet, writeAll } from './fsx'
import { abortReason, FetchLike, parseRetryAfter } from './http'

export interface DownloadOptions {
  fetch: FetchLike
  url: string
  /** Final path, data/<token> */
  target: string
  /** Size announced by On Page, when known */
  expected_size?: number
  signal?: AbortSignal
  headers_timeout_ms?: number
  idle_timeout_ms?: number
  /** Bytes written so far (delta), for progress and speed */
  onBytes?: (delta: number) => void
  /** Content-Length once known */
  onLength?: (length: number) => void
}

const HEADERS_TIMEOUT_MS = 30_000
const IDLE_TIMEOUT_MS = 60_000

/** What fetch and stream readers throw when their signal fires */
function isAbortError(error: unknown): boolean {
  if (error instanceof TimeoutError || error instanceof AbortedError) return true
  const name = (error as { name?: string } | undefined)?.name
  return name == 'AbortError' || name == 'TimeoutError'
}

/** Work on the disk: its errors are the folder's */
function onDisk<T>(work: Promise<T>): Promise<T> {
  return work.catch((error: unknown) => {
    throw new DiskError(error)
  })
}

export async function downloadToFile(options: DownloadOptions): Promise<number> {
  const temp = `${options.target}.${randomBytes(4).toString('hex')}.download`
  // Our timeouts, and the connection closed on a local error; a stop comes with options.signal
  const own = new AbortController()
  const signal = AbortSignal.any(options.signal ? [options.signal, own.signal] : [own.signal])
  const headers_timeout = options.headers_timeout_ms ?? HEADERS_TIMEOUT_MS
  const idle_timeout = options.idle_timeout_ms ?? IDLE_TIMEOUT_MS
  let timer: NodeJS.Timeout | undefined = setTimeout(() => own.abort(new TimeoutError('headers')), headers_timeout)
  const arm = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => own.abort(new TimeoutError('idle')), idle_timeout)
  }
  let handle: FileHandle | undefined
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let written = 0
  try {
    response = await options.fetch(options.url, { signal, redirect: 'follow' })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new HttpError(response.status, parseRetryAfter(response.headers.get('retry-after')))
    }
    const length = Number(response.headers.get('content-length'))
    const expected = options.expected_size ?? (Number.isFinite(length) && length > 0 ? length : undefined)
    if (Number.isFinite(length) && length > 0) options.onLength?.(length)
    // Opening the file is disk work: no network timer meanwhile
    if (timer) clearTimeout(timer)
    timer = undefined
    const file = await onDisk(fs.open(temp, 'w'))
    handle = file
    arm()
    if (response.body) {
      reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        // The idle timer measures the network only: a slow disk (a busy
        // share, an antivirus) must not look like a silent server
        if (timer) clearTimeout(timer)
        timer = undefined
        await onDisk(writeAll(file, value))
        written += value.byteLength
        options.onBytes?.(value.byteLength)
        arm()
      }
    }
    // The network part is over: checking, flushing and renaming are disk work
    if (timer) clearTimeout(timer)
    timer = undefined
    if (expected !== undefined && written != expected) throw new SizeMismatchError(expected, written)
    await onDisk(flushToDisk(file))
    handle = undefined
    await onDisk(file.close())
    await onDisk(renameWithRetry(temp, options.target))
    return written
  } catch (error) {
    // Only an error caused by our timeout is one; a disk error stays a disk error
    const timed_out = own.signal.aborted && isAbortError(error)
    // The connection goes now, not when the body is collected
    own.abort(new AbortedError())
    await (reader ?? response?.body)?.cancel().catch(() => undefined)
    await handle?.close().catch(() => undefined)
    await unlinkQuiet(temp).catch(() => undefined)
    if (options.signal?.aborted) throw new AbortedError()
    if (timed_out) throw abortReason(own.signal, options.signal)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}
