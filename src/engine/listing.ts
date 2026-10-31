/**
 * Reading the file list from On Page.
 *
 * Phase 1, for every resource with media fields: `ids()` of the things with
 * at least one file (cheap). With a valid cache the listing is incremental:
 * only things that are new, or whose `_updated_at` is after the last complete
 * listing (minus a margin), are read again; things that disappeared from
 * `ids()` (deleted, or out of the token's View) are dropped.
 * Phase 2: the things to read, in pages of 1,000, 2 pages at a time, only the
 * media fields. Transport retries (network, 5xx, 429) live in the adapter.
 */
import { Field, OpFile, QueryFilter, Schema, Thing } from 'onpage-js'
import {
  AbortedError,
  HttpError,
  isNetworkError,
  JobError,
  TimeoutError,
} from './errors'
import {
  loadSchema,
  MediaResource,
  mediaResources,
  OnPageContext,
  schemaError,
  schemaSignature,
} from './onpage'
import { runQueue } from './queue'
import { RemoteFileTuple, RemoteIndex, RemoteResource } from './remote-index'

export const PAGE_SIZE = 1000
export const PARALLEL_PAGES = 2
export const MAX_CACHE_AGE_MS = 7 * 24 * 3600 * 1000
export const MARGIN_MS = 10 * 60 * 1000

export interface ListingProgress {
  resource_label?: string
  resources_done: number
  resources_total: number
  things_read: number
  things_total?: number
}

export interface ListingOptions {
  token: string
  ctx: OnPageContext
  cache?: RemoteIndex
  full?: boolean
  page_size?: number
  parallel?: number
  max_cache_age_ms?: number
  margin_ms?: number
  signal?: AbortSignal
  now?: () => number
  onProgress?: (progress: ListingProgress) => void
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
}

export interface FailedResource {
  id: number
  label: string
  error: string
}

export interface ListingResult {
  schema: Schema
  index: RemoteIndex
  /** Every resource was read: removals are allowed */
  complete: boolean
  mode: 'full' | 'incremental'
  failed_resources: FailedResource[]
}

/** The collections not read, for the detail of `listing_incomplete`: three names, then +N */
export function failedLabels(failed: FailedResource[]): string {
  const labels = failed.map(f => f.label)
  return labels.length > 3
    ? `${labels.slice(0, 3).join(', ')} +${labels.length - 3}`
    : labels.join(', ')
}

/** On Page compares dates as text: UTC, `YYYY-MM-DD HH:mm:ss` */
export function formatServerDate(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '')
}

function num(value: unknown): number | null {
  return typeof value == 'number' && Number.isFinite(value) ? value : null
}

/** A thing's files in field, lang and value order; no language fallback */
export function thingFiles(
  thing: Thing,
  fields: Field[],
  langs: string[],
): RemoteFileTuple[] {
  const tuples: RemoteFileTuple[] = []
  for (const field of fields) {
    const field_langs: (string | null)[] = field.is_translatable
      ? langs
      : [null]
    for (const lang of field_langs) {
      const files = thing.values(
        field,
        lang ?? undefined,
        true,
      ) as unknown as OpFile[]
      for (const file of files) {
        if (!file?.token) continue
        tuples.push([
          field.id,
          lang,
          String(file.name ?? file.token),
          String(file.token),
          num(file.size),
          num(file.width),
          num(file.height),
        ])
      }
    }
  }
  return tuples
}

function notEmptyFilter(fields: Field[]): QueryFilter {
  return ['_or', ...fields.map(f => [f.name, 'not_empty', ''] as QueryFilter)]
}

/** Errors that stop the whole listing instead of one resource: stop, token refused, no network */
function isFatal(error: unknown): boolean {
  if (error instanceof AbortedError || error instanceof JobError) return true
  if (error instanceof HttpError)
    return error.status == 401 || error.status == 403
  if (error instanceof TimeoutError) return false
  return isNetworkError(error)
}

interface ResourceWork {
  media: MediaResource
  label: string
  things: Map<number, RemoteFileTuple[]>
  to_read: number[]
  pages_left: number
  failed?: string
}

export async function listRemote(
  options: ListingOptions,
): Promise<ListingResult> {
  const now = options.now ?? Date.now
  const page_size = options.page_size ?? PAGE_SIZE
  let server_now: number | undefined
  const ctx: OnPageContext = {
    ...options.ctx,
    signal: () => options.signal ?? options.ctx.signal?.(),
    onServerDate: date => {
      server_now ??= date.getTime()
      options.ctx.onServerDate?.(date)
    },
  }

  const schema = await loadSchema(options.token, ctx)
  /** Changes made while we read are caught by the next listing */
  const started_at = server_now ?? now()
  const signature = schemaSignature(schema, options.token)
  const cache = options.cache
  const cache_age = cache ? now() - Date.parse(cache.checkpoint) : Infinity
  const incremental =
    !options.full &&
    !!cache &&
    cache.signature == signature &&
    cache.schema_id == schema.id &&
    Number.isFinite(cache_age) &&
    cache_age < (options.max_cache_age_ms ?? MAX_CACHE_AGE_MS)
  const since = incremental
    ? formatServerDate(
        Date.parse(cache.checkpoint) - (options.margin_ms ?? MARGIN_MS),
      )
    : undefined

  const media = mediaResources(schema)
  const progress: ListingProgress = {
    resources_done: 0,
    resources_total: media.length,
    things_read: 0,
  }
  const report = (): void => options.onProgress?.({ ...progress })
  const lang = schema.lang ?? schema.default_lang
  const work: ResourceWork[] = []

  // Phase 1: which things to read
  for (const item of media) {
    if (options.signal?.aborted) throw new AbortedError()
    const label = safeLabel(
      () => item.resource.getLabel(lang),
      item.resource.name,
    )
    progress.resource_label = label
    report()
    const entry: ResourceWork = {
      media: item,
      label,
      things: new Map(),
      to_read: [],
      pages_left: 0,
    }
    work.push(entry)
    try {
      const ids = (
        await item.resource.query().filter(notEmptyFilter(item.fields)).ids()
      ).map(Number)
      const cached = incremental
        ? cache.resources.find(r => r.id == item.resource.id)
        : undefined
      if (cached) {
        const current = new Set(ids)
        for (const [id, tuples] of cached.things)
          if (current.has(id)) entry.things.set(id, tuples)
        const updated = new Set(
          (
            await item.resource
              .query()
              .filter(notEmptyFilter(item.fields))
              .filter(['_updated_at', '>', since!] as unknown as QueryFilter)
              .ids()
          ).map(Number),
        )
        entry.to_read = ids.filter(
          id => !cached.things.has(id) || updated.has(id),
        )
      } else {
        entry.to_read = ids
      }
    } catch (error) {
      if (isFatal(error)) throw fatal(error)
      entry.failed = describe(error)
      options.log?.('warn', `Listing of ${label} failed: ${entry.failed}`)
    }
  }
  progress.things_total = work.reduce((sum, w) => sum + w.to_read.length, 0)
  report()

  // Phase 2: read the things, page by page
  const pages: { work: ResourceWork; ids: number[] }[] = []
  for (const entry of work) {
    if (entry.failed) continue
    for (let i = 0; i < entry.to_read.length; i += page_size) {
      pages.push({ work: entry, ids: entry.to_read.slice(i, i + page_size) })
      entry.pages_left++
    }
    if (!entry.pages_left) progress.resources_done++
  }
  report()

  await runQueue(
    pages,
    options.parallel ?? PARALLEL_PAGES,
    async page => {
      const entry = page.work
      if (entry.failed) return
      try {
        const things = await entry.media.resource
          .query()
          .setFields(entry.media.fields.map(f => f.name))
          .where('_id', 'in', page.ids)
          .all()
        const seen = new Set<number>()
        for (const thing of things) {
          const id = Number(thing.id)
          seen.add(id)
          const tuples = thingFiles(thing, entry.media.fields, schema.langs)
          if (tuples.length) entry.things.set(id, tuples)
          else entry.things.delete(id)
        }
        // Asked for but not returned: gone in the meantime
        for (const id of page.ids) if (!seen.has(id)) entry.things.delete(id)
        progress.things_read += page.ids.length
      } catch (error) {
        if (isFatal(error)) throw fatal(error)
        entry.failed = describe(error)
        options.log?.(
          'warn',
          `Listing of ${entry.label} failed: ${entry.failed}`,
        )
      }
      entry.pages_left--
      if (!entry.pages_left) progress.resources_done++
      progress.resource_label = entry.label
      report()
    },
    options.signal,
  )
  if (options.signal?.aborted) throw new AbortedError()

  const failed_resources = work
    .filter(w => w.failed)
    .map(w => ({ id: w.media.resource.id, label: w.label, error: w.failed! }))
  if (media.length && failed_resources.length == media.length) {
    throw new JobError(
      'listing_failed',
      'The file list could not be read',
      failed_resources[0].error,
    )
  }

  // A resource that failed keeps what the cache knew (no removals anyway)
  const resources: RemoteResource[] = work.map(w => {
    if (!w.failed) return { id: w.media.resource.id, things: w.things }
    const cached = cache?.resources.find(r => r.id == w.media.resource.id)
    return {
      id: w.media.resource.id,
      things: cached ? new Map(cached.things) : new Map(),
    }
  })

  return {
    schema,
    index: {
      schema_id: schema.id,
      signature,
      checkpoint: new Date(started_at).toISOString(),
      resources,
    },
    complete: failed_resources.length == 0,
    mode: incremental ? 'incremental' : 'full',
    failed_resources,
  }
}

function fatal(error: unknown): Error {
  if (error instanceof AbortedError || error instanceof JobError) return error
  return schemaError(error)
}

function describe(error: unknown): string {
  if (error instanceof HttpError) return `HTTP ${error.status}`
  return String((error as Error)?.message ?? error)
}

function safeLabel(get: () => string, fallback: string): string {
  try {
    return get() || fallback
  } catch {
    return fallback
  }
}
