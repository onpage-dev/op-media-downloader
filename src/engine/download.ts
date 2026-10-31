/**
 * One file from the storage to data/<token>: stream to <token>.download with
 * a timeout before the first byte and between chunks, check the size, then
 * rename (retrying transient Windows locks). Nothing is left behind on error.
 */
import { promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import {
  AbortedError,
  HttpError,
  SizeMismatchError,
  TimeoutError,
} from './errors'
import { renameWithRetry, unlinkQuiet } from './fsx'
import {
  abortReason,
  FetchLike,
  linkedController,
  parseRetryAfter,
} from './http'

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

export const HEADERS_TIMEOUT_MS = 30_000
export const IDLE_TIMEOUT_MS = 60_000

/** What fetch and stream readers throw when their signal fires */
function isAbortError(error: unknown): boolean {
  if (error instanceof TimeoutError || error instanceof AbortedError)
    return true
  const name = (error as { name?: string } | undefined)?.name
  return name == 'AbortError' || name == 'TimeoutError'
}

export async function downloadToFile(
  options: DownloadOptions,
): Promise<number> {
  const temp = `${options.target}.download`
  const { controller, dispose } = linkedController(options.signal)
  const headers_timeout = options.headers_timeout_ms ?? HEADERS_TIMEOUT_MS
  const idle_timeout = options.idle_timeout_ms ?? IDLE_TIMEOUT_MS
  let timer: NodeJS.Timeout | undefined = setTimeout(
    () => controller.abort(new TimeoutError('headers')),
    headers_timeout,
  )
  const arm = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(
      () => controller.abort(new TimeoutError('idle')),
      idle_timeout,
    )
  }
  let handle: FileHandle | undefined
  let written = 0
  try {
    const response = await options.fetch(options.url, {
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new HttpError(
        response.status,
        parseRetryAfter(response.headers.get('retry-after')),
      )
    }
    const length = Number(response.headers.get('content-length'))
    const expected =
      options.expected_size ??
      (Number.isFinite(length) && length > 0 ? length : undefined)
    if (Number.isFinite(length) && length > 0) options.onLength?.(length)
    // Opening the file is disk work: no network timer meanwhile
    if (timer) clearTimeout(timer)
    timer = undefined
    handle = await fs.open(temp, 'w')
    arm()
    if (response.body) {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        // The idle timer measures the network only: a slow disk (a busy
        // share, an antivirus) must not look like a silent server
        if (timer) clearTimeout(timer)
        timer = undefined
        await handle.write(value)
        written += value.byteLength
        options.onBytes?.(value.byteLength)
        arm()
      }
    }
    // The network part is over: closing and renaming are disk work
    if (timer) clearTimeout(timer)
    timer = undefined
    await handle.close()
    handle = undefined
    if (expected !== undefined && written != expected)
      throw new SizeMismatchError(expected, written)
    await renameWithRetry(temp, options.target)
    return written
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlinkQuiet(temp).catch(() => undefined)
    if (options.signal?.aborted) throw new AbortedError()
    // Only an error caused by the abort is a timeout; a disk error stays a disk error
    if (controller.signal.aborted && isAbortError(error))
      throw abortReason(controller.signal, options.signal)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    dispose()
  }
}
