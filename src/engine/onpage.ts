/**
 * On Page access through onpage-js, with our transport (fetch adapter):
 * schema loading, token checks, media fields and storage links.
 */
import { createHash } from 'crypto'
import { Api, ApiOptions, Field, Resource, Schema } from 'onpage-js'
import { TokenCheck } from '../shared/models'
import { HttpError, isNetworkError, JobError, TimeoutError } from './errors'
import { API_RETRY, fetchAdapter, FetchLike, RetryPolicy } from './http'

export const DEFAULT_DOMAIN = 'https://app.onpage.it'

export interface OnPageContext {
  fetch: FetchLike
  domain?: string
  policy?: RetryPolicy
  timeout_ms?: number
  /** The signal of the running job, read at each request */
  signal?: () => AbortSignal | undefined
  onRetry?: (error: unknown, attempt: number, delay_ms: number) => void
  onServerDate?: (date: Date) => void
}

export interface MediaResource {
  resource: Resource
  fields: Field[]
}

type AxiosLike = { defaults: { adapter?: unknown } }

function useAdapter(api: { http?: AxiosLike }, ctx: OnPageContext): void {
  if (!api.http) return
  api.http.defaults.adapter = fetchAdapter({
    fetch: ctx.fetch,
    policy: ctx.policy ?? API_RETRY,
    timeout_ms: ctx.timeout_ms,
    signal: ctx.signal,
    onRetry: ctx.onRetry,
    onServerDate: ctx.onServerDate,
  })
}

export function createApi(token: string, ctx: OnPageContext): Api {
  const api = new Api({
    token,
    domain: (ctx.domain ?? DEFAULT_DOMAIN) as ApiOptions['domain'],
  })
  useAdapter(api, ctx)
  return api
}

/** Turns transport errors on the schema into the issue the user sees */
export function schemaError(error: unknown): JobError {
  if (error instanceof JobError) return error
  if (error instanceof HttpError && (error.status == 401 || error.status == 403)) {
    return new JobError('token_invalid', 'The API token was refused', `HTTP ${error.status}`)
  }
  if (isNetworkError(error) || error instanceof TimeoutError) {
    return new JobError('offline', 'On Page cannot be reached', String((error as Error).message))
  }
  return new JobError(
    'project_unavailable',
    'The project could not be loaded',
    error instanceof HttpError ? `HTTP ${error.status}` : String((error as Error)?.message ?? error),
  )
}

export async function loadSchema(token: string, ctx: OnPageContext): Promise<Schema> {
  const api = createApi(token, ctx)
  let schema: Schema
  try {
    schema = await api.loadSchema()
  } catch (error) {
    throw schemaError(error)
  }
  // loadSchema clones the Api: the clone needs our transport too
  useAdapter(schema.api as unknown as { http: AxiosLike }, ctx)
  return schema
}

/** Resources with at least one file or image field, in schema order */
export function mediaResources(schema: Schema): MediaResource[] {
  return schema.resources
    .map(resource => ({
      resource,
      fields: resource.fields.filter(f => f.isMedia()),
    }))
    .filter(r => r.fields.length > 0)
}

/** Changes when what the listing reads changes: media fields, langs, project */
export function schemaSignature(schema: Schema, token: string): string {
  const shape = {
    schema: schema.id,
    token: createHash('sha256').update(token).digest('hex'),
    langs: schema.langs,
    resources: mediaResources(schema).map(({ resource, fields }) => [
      resource.id,
      fields.map(f => [f.id, f.type, f.is_translatable]),
    ]),
  }
  return createHash('sha1').update(JSON.stringify(shape)).digest('hex')
}

export async function verifyToken(token: string, ctx: OnPageContext): Promise<TokenCheck> {
  try {
    const schema = await loadSchema(token, ctx)
    return {
      ok: true,
      project_label: schema.label,
      collections_with_files: mediaResources(schema).length,
      langs: schema.langs,
    }
  } catch (error) {
    const issue = schemaError(error).issue
    return {
      ok: false,
      error: issue == 'token_invalid' || issue == 'offline' ? issue : 'project_unavailable',
    }
  }
}

/** A storage URL builder without network: `file.link()` of onpage-js */
export function storageLinker(domain = DEFAULT_DOMAIN): (token: string, name: string) => string {
  const api = new Api({ token: '', domain: domain as ApiOptions['domain'] })
  return (token, name) => api.storageLink(token, name)
}

export function thingEditUrl(schema_id: number, resource_id: number, thing_id: number, field_id: number): string {
  return `https://app.onpage.it/#/things/edit/${thing_id}/${schema_id}/${resource_id}/${field_id}`
}
