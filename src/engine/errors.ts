/**
 * Error types of the engine and how they map to failure codes, issues and
 * retry decisions.
 */
import { FailureCode, IssueCode } from '../shared/models'

/** A non-2xx answer from On Page or from the storage */
export class HttpError extends Error {
  constructor(
    public status: number,
    public retry_after_ms?: number,
    public body?: unknown,
  ) {
    super(`HTTP ${status}`)
    this.name = 'HttpError'
  }
}

/** No answer in time: `headers` before the first byte, `idle` between two chunks */
export class TimeoutError extends Error {
  constructor(public stage: 'headers' | 'idle' | 'request') {
    super(`Timeout (${stage})`)
    this.name = 'TimeoutError'
  }
}

export class SizeMismatchError extends Error {
  constructor(public expected: number, public actual: number) {
    super(`Expected ${expected} bytes, got ${actual}`)
    this.name = 'SizeMismatchError'
  }
}

/** The user (or the job) stopped the work */
export class AbortedError extends Error {
  constructor() {
    super('Aborted')
    this.name = 'AbortedError'
  }
}

/** A name in the folder that the app did not create blocks a remote file */
export class ConflictError extends Error {
  constructor(public file_name: string) {
    super(`"${file_name}" already exists and was not created by the app`)
    this.name = 'ConflictError'
  }
}

/** Windows: the file is open in another program, it cannot be replaced or removed now */
export class InUseError extends Error {
  constructor(
    public file_name: string,
    cause?: unknown,
  ) {
    super(`"${file_name}" is open in another program`, { cause })
    this.name = 'InUseError'
  }
}

/** An error that ends the whole job, with the issue to show */
export class JobError extends Error {
  constructor(
    public issue: IssueCode,
    message?: string,
    public detail?: string,
  ) {
    super(message ?? issue)
    this.name = 'JobError'
  }
}

/** Node / libuv error code of a file system or socket error */
export function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code) return code
  const cause = (error as { cause?: unknown } | undefined)?.cause
  return cause ? errorCode(cause) : undefined
}

export function isNotFound(error: unknown): boolean {
  return errorCode(error) == 'ENOENT'
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
])

/** Connection problems from Node's fetch (undici) or from Electron's net.fetch */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof HttpError || error instanceof SizeMismatchError)
    return false
  const code = errorCode(error)
  if (code && NETWORK_CODES.has(code)) return true
  const message = String((error as Error | undefined)?.message ?? '')
  return (
    message.includes('net::ERR_') ||
    message == 'fetch failed' ||
    message.includes('terminated') ||
    message.includes('socket hang up') ||
    message.includes('other side closed')
  )
}

/** Errors worth another attempt */
export function isRetryable(error: unknown): boolean {
  if (error instanceof AbortedError || error instanceof ConflictError)
    return false
  if (error instanceof TimeoutError || error instanceof SizeMismatchError)
    return true
  if (error instanceof HttpError) {
    return error.status == 408 || error.status == 429 || error.status >= 500
  }
  return isNetworkError(error)
}

/** Disk full: there is no point in going on */
export function isDiskFull(error: unknown): boolean {
  const code = errorCode(error)
  return code == 'ENOSPC' || code == 'EDQUOT'
}

/**
 * The folder went away (a share, a disk unplugged), not a problem of one
 * file. Windows reports a dropped share as ECONNRESET (NETNAME_DELETED),
 * ETIMEDOUT (SEM_TIMEOUT) or UNKNOWN; a removed disk as EIO, ENXIO or ENODEV.
 */
export const FOLDER_GONE_CODES = new Set([
  'ENOENT',
  'EIO',
  'ENXIO',
  'ENODEV',
  'ENOMEDIUM',
  'ESTALE',
  'ENOTCONN',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EBADF',
  'UNKNOWN',
])

export const NOT_WRITABLE_CODES = new Set(['EACCES', 'EPERM', 'EROFS'])

/** A file system error as the end of a job: disk full, read-only, gone */
export function folderJobError(error: unknown): JobError | undefined {
  if (error instanceof JobError) return error
  const detail = errorDetail(error)
  if (isDiskFull(error)) return new JobError('disk_full', 'The disk is full', detail)
  const code = errorCode(error) ?? ''
  if (NOT_WRITABLE_CODES.has(code))
    return new JobError('folder_not_writable', 'The folder cannot be written', detail)
  if (FOLDER_GONE_CODES.has(code))
    return new JobError('folder_unreachable', 'The folder cannot be reached', detail)
  return undefined
}

export function failureCode(error: unknown): FailureCode {
  if (error instanceof AbortedError) return 'aborted'
  if (error instanceof ConflictError) return 'name_conflict'
  if (error instanceof InUseError) return 'in_use'
  if (errorCode(error) == 'EFBIG') return 'file_too_large'
  if (error instanceof TimeoutError) return 'timeout'
  if (error instanceof SizeMismatchError) return 'size_mismatch'
  if (error instanceof HttpError) {
    if (error.status == 404 || error.status == 410) return 'not_found'
    if (error.status == 429) return 'rate_limited'
    return 'http_error'
  }
  if (isDiskFull(error)) return 'disk_full'
  if (isNetworkError(error)) return 'network'
  return 'write_error'
}

/** Short technical detail for logs and the failed list */
export function errorDetail(error: unknown): string {
  if (error instanceof HttpError) return `HTTP ${error.status}`
  const code = errorCode(error)
  const message = (error as Error | undefined)?.message ?? String(error)
  return code && !message.includes(code) ? `${code}: ${message}` : message
}
