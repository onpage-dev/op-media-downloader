/**
 * The engine's timings and limits. Tests pass shorter ones.
 */
import { API_RETRY, DOWNLOAD_RETRY, RetryPolicy } from './http'
import { PAGE_SIZE, PARALLEL_PAGES } from './listing'

export interface EngineTimings {
  state_interval_ms: number
  activity_interval_ms: number
  /** A listing kept in memory is reused by «Scarica» for this long, then dropped */
  listing_max_age_ms: number
  api_policy: RetryPolicy
  download_policy: RetryPolicy
  api_timeout_ms: number
  headers_timeout_ms: number
  idle_timeout_ms: number
  page_size: number
  parallel_pages: number
  lock_stale_ms?: number
  lock_heartbeat_ms?: number
  /** A folder root that does not answer in this time is unreachable */
  reach_timeout_ms: number
}

export const DEFAULT_TIMINGS: EngineTimings = {
  state_interval_ms: 250,
  activity_interval_ms: 250,
  listing_max_age_ms: 30 * 60 * 1000,
  api_policy: API_RETRY,
  download_policy: DOWNLOAD_RETRY,
  api_timeout_ms: 120_000,
  headers_timeout_ms: 30_000,
  idle_timeout_ms: 60_000,
  page_size: PAGE_SIZE,
  parallel_pages: PARALLEL_PAGES,
  reach_timeout_ms: 15_000,
}
