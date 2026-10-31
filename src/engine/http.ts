/**
 * HTTP for the engine: an injected `fetch` (Electron's `net.fetch` in the
 * utility process, so the system proxy applies; Node's `fetch` in tests),
 * timeouts, retries with backoff and an axios adapter for onpage-js.
 */
import { AbortedError, HttpError, isRetryable, TimeoutError } from './errors'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface RetryPolicy {
  /** Total attempts, the first included */
  attempts: number
  base_delay_ms: number
  max_delay_ms: number
  /** Longest wait accepted from a Retry-After header */
  max_retry_after_ms: number
}

export const API_RETRY: RetryPolicy = {
  attempts: 6,
  base_delay_ms: 1000,
  max_delay_ms: 30_000,
  max_retry_after_ms: 120_000,
}

export const DOWNLOAD_RETRY: RetryPolicy = {
  attempts: 4,
  base_delay_ms: 1000,
  max_delay_ms: 30_000,
  max_retry_after_ms: 120_000,
}

/** Resolves after `ms`, rejects with AbortedError when the signal fires */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new AbortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Exponential backoff with ±25% jitter */
export function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const base = Math.min(
    policy.max_delay_ms,
    policy.base_delay_ms * 2 ** Math.max(0, attempt - 1),
  )
  return Math.round(base * (0.75 + Math.random() * 0.5))
}

/** Retry-After as seconds or as an HTTP date, in milliseconds */
export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

export interface RetryHooks {
  signal?: AbortSignal
  /** Called before each wait; `error` is what failed */
  onRetry?: (error: unknown, attempt: number, delay_ms: number) => void
}

export async function withRetry<T>(
  policy: RetryPolicy,
  hooks: RetryHooks,
  task: (attempt: number) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    if (hooks.signal?.aborted) throw new AbortedError()
    try {
      return await task(attempt)
    } catch (error) {
      if (hooks.signal?.aborted) throw new AbortedError()
      if (attempt >= policy.attempts || !isRetryable(error)) throw error
      let delay = backoffDelay(attempt, policy)
      if (error instanceof HttpError && error.retry_after_ms !== undefined) {
        delay = Math.max(
          delay,
          Math.min(error.retry_after_ms, policy.max_retry_after_ms),
        )
      }
      hooks.onRetry?.(error, attempt, delay)
      await sleep(delay, hooks.signal)
    }
  }
}

/** An AbortController that follows a parent signal and can time out */
export function linkedController(parent?: AbortSignal): {
  controller: AbortController
  dispose: () => void
} {
  const controller = new AbortController()
  if (parent?.aborted) controller.abort(parent.reason)
  const onAbort = (): void => controller.abort(parent?.reason)
  parent?.addEventListener('abort', onAbort, { once: true })
  return {
    controller,
    dispose: () => parent?.removeEventListener('abort', onAbort),
  }
}

/** Turns an abort into the right error: our timeout, or the user's stop */
export function abortReason(signal: AbortSignal, parent?: AbortSignal): Error {
  if (parent?.aborted) return new AbortedError()
  const reason = signal.reason
  return reason instanceof Error ? reason : new AbortedError()
}

/* ------------------------------------------------------------------ onpage-js adapter */

/** The fields of an axios request config the adapter reads */
interface AdapterConfig {
  url?: string
  baseURL?: string
  method?: string
  data?: unknown
  headers?: { toJSON?: () => Record<string, unknown> } & Record<string, unknown>
  timeout?: number
}

interface AdapterResponse {
  data: unknown
  status: number
  statusText: string
  headers: Record<string, string>
  config: AdapterConfig
  request: undefined
}

export interface AdapterOptions {
  fetch: FetchLike
  policy?: RetryPolicy
  /** Per attempt, whole request (headers and body) */
  timeout_ms?: number
  /** Read at each request: the signal of the running job */
  signal?: () => AbortSignal | undefined
  onRetry?: (error: unknown, attempt: number, delay_ms: number) => void
  /** Each successful answer's Date header (server clock) */
  onServerDate?: (date: Date) => void
}

export function joinUrl(
  base: string | undefined,
  url: string | undefined,
): string {
  if (url && /^https?:\/\//i.test(url)) return url
  const left = (base ?? '').replace(/\/+$/, '')
  const right = (url ?? '').replace(/^\/+/, '')
  return right ? `${left}/${right}` : left
}

function flattenHeaders(
  headers: AdapterConfig['headers'],
): Record<string, string> {
  const raw = headers?.toJSON ? headers.toJSON() : headers ?? {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null || value === false) continue
    if (typeof value == 'object') continue
    out[key] = String(value)
  }
  return out
}

/**
 * An axios adapter (`api.http.defaults.adapter`) that sends onpage-js
 * requests through the injected fetch, with a timeout per attempt and
 * retries on network errors, 5xx and 429.
 */
export function fetchAdapter(
  options: AdapterOptions,
): (config: AdapterConfig) => Promise<AdapterResponse> {
  const policy = options.policy ?? API_RETRY
  const timeout_ms = options.timeout_ms ?? 120_000
  return async config => {
    const parent = options.signal?.()
    const url = joinUrl(config.baseURL, config.url)
    const method = (config.method ?? 'get').toUpperCase()
    const headers = flattenHeaders(config.headers)
    const body =
      config.data === undefined || method == 'GET'
        ? undefined
        : typeof config.data == 'string'
        ? config.data
        : JSON.stringify(config.data)
    return withRetry(
      policy,
      { signal: parent, onRetry: options.onRetry },
      async () => {
        const { controller, dispose } = linkedController(parent)
        const timer = setTimeout(
          () => controller.abort(new TimeoutError('request')),
          timeout_ms,
        )
        try {
          const response = await options.fetch(url, {
            method,
            headers,
            body,
            signal: controller.signal,
          })
          const text = await response.text()
          if (!response.ok) {
            throw new HttpError(
              response.status,
              parseRetryAfter(response.headers.get('retry-after')),
              safeJson(text),
            )
          }
          const date = response.headers.get('date')
          if (date && options.onServerDate) {
            const parsed = new Date(date)
            if (!isNaN(parsed.getTime())) options.onServerDate(parsed)
          }
          const out_headers: Record<string, string> = {}
          response.headers.forEach((value, key) => (out_headers[key] = value))
          return {
            data: text,
            status: response.status,
            statusText: response.statusText,
            headers: out_headers,
            config,
            request: undefined,
          }
        } catch (error) {
          if (controller.signal.aborted)
            throw abortReason(controller.signal, parent)
          throw error
        } finally {
          clearTimeout(timer)
          dispose()
        }
      },
    )
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
