/**
 * A fake On Page for tests and for trying the whole app without real data:
 * it answers the API (`/view/<token>/schema`, `/view/<token>/things`, the
 * calls onpage-js makes) and the storage links (`/<token>/<name>`) on the
 * same host, with switches for the bad days (429, 500, reset, mute, 404).
 *
 * Standalone (Node 22 runs TypeScript directly):
 *   node src/engine/testing/fake-onpage-server.ts --port 4310 --things 3000
 * then start the app with OPMD_API_DOMAIN=http://127.0.0.1:4310 and the
 * token printed on the console.
 *
 * Self-contained on purpose: Node built-ins only and erasable TypeScript, so
 * the file runs with `node` as it is.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo, Socket } from 'node:net'
import { pathToFileURL } from 'node:url'

export interface FakeFile {
  token: string
  name: string
  /** Size announced by the API; defaults to the content length */
  size?: number
  width?: number
  height?: number
  /** Served bytes; generated from the token when missing */
  content?: Buffer
}

export interface FakeField {
  id: number
  name: string
  type: 'image' | 'file' | 'string'
  translatable?: boolean
  textual?: boolean
  label: string
}

export interface FakeResource {
  id: number
  name: string
  label: string
  fields: FakeField[]
}

export interface FakeThing {
  id: number
  resource_id: number
  /** field name → files; translatable fields: field name → lang → files */
  files: Record<string, FakeFile[] | Record<string, FakeFile[]>>
  label?: string
  updated_at: string
}

export interface FakeProject {
  id: number
  label: string
  langs: string[]
  resources: FakeResource[]
  things: FakeThing[]
}

/** Per-token storage behaviour */
export interface StorageBehaviour {
  /** Answer 404 */
  missing?: boolean
  /** Answer 500 this many times, then serve */
  fail_times?: number
  /** Reset the connection this many times, then serve */
  reset_times?: number
  /** Send headers and then nothing, forever */
  mute?: boolean
  /** Answer 429 with this Retry-After (seconds) this many times */
  rate_limit_times?: number
  retry_after_s?: number
  /** Wait before answering (ms) */
  delay_ms?: number
}

export interface FakeOnPage {
  url: string
  port: number
  token: string
  project: FakeProject
  storage: Map<string, StorageBehaviour>
  /** API: 429 or 500 to the next N requests; always 500 for one resource (by name) */
  api: {
    rate_limit_times: number
    fail_times: number
    retry_after_s: number
    delay_ms: number
    fail_resource?: string
  }
  hits: { api: number; storage: Map<string, number> }
  /** Marks a thing as changed now (for `_updated_at` filters) */
  touch(thing_id: number): void
  close(): Promise<void>
}

export function fileContent(file: FakeFile): Buffer {
  if (file.content) return file.content
  const size = file.size ?? 64
  const seed = createHash('sha256').update(file.token).digest()
  const out = Buffer.alloc(size)
  for (let i = 0; i < size; i++) out[i] = seed[i % seed.length]
  return out
}

function now(): string {
  return new Date()
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '')
}

const STAMP = '2026-01-01 00:00:00'

function schemaJson(project: FakeProject): unknown {
  return {
    id: project.id,
    company_id: 1,
    label: project.label,
    langs: project.langs,
    default_lang: project.langs[0],
    created_at: STAMP,
    updated_at: STAMP,
    resources: project.resources.map(r => ({
      id: r.id,
      name: r.name,
      label: r.label,
      labels: { [project.langs[0]]: r.label },
      opts: {},
      created_at: STAMP,
      updated_at: STAMP,
      fields: r.fields.map((f, order) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        is_translatable: !!f.translatable,
        is_multiple: true,
        is_textual: !!f.textual,
        resource_id: r.id,
        order,
        opts: {},
        label: f.label,
        labels: { [project.langs[0]]: f.label },
        descriptions: {},
        created_at: STAMP,
        updated_at: STAMP,
      })),
    })),
  }
}

function rawFile(file: FakeFile): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    name: file.name,
    token: file.token,
    size: file.size ?? fileContent(file).length,
  }
  if (file.width) raw.width = file.width
  if (file.height) raw.height = file.height
  return raw
}

function thingFiles(thing: FakeThing, field: FakeField): FakeFile[] {
  const value = thing.files[field.name]
  if (!value) return []
  if (Array.isArray(value)) return value
  return Object.values(value).flat()
}

function hasMedia(thing: FakeThing, fields: FakeField[]): boolean {
  return fields.some(f => thingFiles(thing, f).length > 0)
}

type Clause = unknown[] | { field?: string; operator?: string; value?: unknown }

/** The filters onpage-js and the engine send: `_or` not_empty, `_updated_at >`, `_id in` */
function matches(
  thing: FakeThing,
  resource: FakeResource,
  filters: Clause[],
): boolean {
  for (const clause of filters) {
    if (Array.isArray(clause)) {
      if (clause[0] == '_or') {
        const names = (clause.slice(1) as unknown[][]).map(c => String(c[0]))
        const fields = resource.fields.filter(f => names.includes(f.name))
        if (!hasMedia(thing, fields)) return false
        continue
      }
      if (clause[0] == '_updated_at' && clause[1] == '>') {
        if (!(thing.updated_at > String(clause[2]))) return false
        continue
      }
      continue
    }
    if (clause && clause.field == '_id' && clause.operator == 'in') {
      if (!(clause.value as number[]).map(Number).includes(thing.id))
        return false
    }
  }
  return true
}

function thingJson(
  thing: FakeThing,
  resource: FakeResource,
  wanted: string[],
  langs: string[],
): unknown {
  const fields: Record<string, unknown[]> = {}
  for (const field of resource.fields) {
    if (wanted.length && !wanted.includes(field.name)) continue
    if (field.type == 'string') {
      if (thing.label !== undefined)
        fields[field.translatable ? `${field.name}_${langs[0]}` : field.name] =
          [thing.label]
      continue
    }
    const value = thing.files[field.name]
    if (!value) continue
    if (field.translatable) {
      for (const lang of langs) {
        const files = Array.isArray(value)
          ? lang == langs[0]
            ? value
            : []
          : value[lang] ?? []
        if (files.length) fields[`${field.name}_${lang}`] = files.map(rawFile)
      }
    } else {
      const files = Array.isArray(value) ? value : Object.values(value).flat()
      if (files.length) fields[field.name] = files.map(rawFile)
    }
  }
  return {
    id: thing.id,
    resource_id: thing.resource_id,
    fields,
    relations: {},
    rel_ids: {},
    created_at: STAMP,
    updated_at: thing.updated_at,
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...headers,
  })
  res.end(text)
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function startFakeOnPage(options: {
  project: FakeProject
  token?: string
  port?: number
}): Promise<FakeOnPage> {
  const token = options.token ?? 'fake-token'
  const sockets = new Set<Socket>()
  const fake: FakeOnPage = {
    url: '',
    port: 0,
    token,
    project: options.project,
    storage: new Map(),
    api: { rate_limit_times: 0, fail_times: 0, retry_after_s: 1, delay_ms: 0 },
    hits: { api: 0, storage: new Map() },
    touch(thing_id: number): void {
      const thing = fake.project.things.find(t => t.id == thing_id)
      if (thing) thing.updated_at = now()
    },
    close: () => close(),
  }

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent)

    if (parts[0] == 'view') {
      fake.hits.api++
      const body = req.method == 'POST' ? await readBody(req) : ''
      const auth = req.headers.authorization ?? parts[1]
      const path_token =
        parts[0] == 'view' && parts.length > 2 ? parts[1] : undefined
      if (fake.api.delay_ms) await wait(fake.api.delay_ms)
      if ((path_token ?? auth) != token && auth != token)
        return json(res, 401, { message: 'Unauthenticated' })
      if (fake.api.rate_limit_times > 0) {
        fake.api.rate_limit_times--
        return json(
          res,
          429,
          { message: 'Too many requests', load_1min: 6.2, max_load_1min: 5 },
          { 'retry-after': String(fake.api.retry_after_s) },
        )
      }
      if (fake.api.fail_times > 0) {
        fake.api.fail_times--
        return json(res, 500, { message: 'Server error' })
      }
      const endpoint = parts[parts.length - 1]
      const data = body ? JSON.parse(body) : {}
      if (endpoint == 'schema') return json(res, 200, schemaJson(fake.project))
      if (endpoint == 'things') {
        if (fake.api.fail_resource && data.resource == fake.api.fail_resource)
          return json(res, 500, { message: 'Server error' })
        const resource = fake.project.resources.find(
          r => r.name == data.resource || r.id == data.resource,
        )
        if (!resource) return json(res, 404, { message: 'Resource not found' })
        const filters: Clause[] = Array.isArray(data.filters)
          ? data.filters
          : []
        const things = fake.project.things
          .filter(t => t.resource_id == resource.id)
          .filter(t => matches(t, resource, filters))
          .sort((a, b) => a.id - b.id)
        if (data.return == 'ids')
          return json(
            res,
            200,
            things.map(t => t.id),
          )
        if (data.return == 'count') return json(res, 200, things.length)
        const wanted = (Array.isArray(data.fields) ? data.fields : []).filter(
          (f: unknown) => typeof f == 'string',
        ) as string[]
        return json(
          res,
          200,
          things.map(t => thingJson(t, resource, wanted, fake.project.langs)),
        )
      }
      return json(res, 404, { message: 'Not found' })
    }

    // Storage: /<token>[.transform]/<name> (sample tokens have no dots)
    const file_token = (parts[0] ?? '').split('.')[0]
    const file = findFile(fake.project, file_token)
    fake.hits.storage.set(
      file_token,
      (fake.hits.storage.get(file_token) ?? 0) + 1,
    )
    const behaviour = fake.storage.get(file_token) ?? {}
    if (behaviour.delay_ms) await wait(behaviour.delay_ms)
    if (!file || behaviour.missing)
      return json(res, 404, { message: 'Not found' })
    if (behaviour.rate_limit_times) {
      behaviour.rate_limit_times--
      return json(
        res,
        429,
        { message: 'Too many requests' },
        { 'retry-after': String(behaviour.retry_after_s ?? 1) },
      )
    }
    if (behaviour.fail_times) {
      behaviour.fail_times--
      return json(res, 500, { message: 'Server error' })
    }
    if (behaviour.reset_times) {
      behaviour.reset_times--
      req.socket.destroy()
      return
    }
    const content = fileContent(file)
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': content.length,
    })
    if (behaviour.mute) {
      res.flushHeaders()
      return
    }
    res.end(content)
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(error => {
      if (!res.headersSent) json(res, 500, { message: String(error) })
      else res.destroy()
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>(resolve =>
    server.listen(options.port ?? 0, '127.0.0.1', resolve),
  )
  fake.port = (server.address() as AddressInfo).port
  fake.url = `http://127.0.0.1:${fake.port}`

  function close(): Promise<void> {
    for (const socket of sockets) socket.destroy()
    return new Promise(resolve => server.close(() => resolve()))
  }
  return fake
}

function findFile(project: FakeProject, token: string): FakeFile | undefined {
  for (const thing of project.things) {
    for (const value of Object.values(thing.files)) {
      const files = Array.isArray(value) ? value : Object.values(value).flat()
      const found = files.find(f => f.token == token)
      if (found) return found
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ sample data */

export function token(seed: string): string {
  return createHash('sha1').update(seed).digest('hex')
}

/**
 * A project with two collections: «Prodotti» (photo + gallery, a label field)
 * and «Schede tecniche» (a translatable PDF field, it/en). Some files share
 * a content (same token, two names) and a few names have different files
 * (duplicates).
 */
export function sampleProject(
  options: { things?: number; duplicates?: number; seed?: string } = {},
): FakeProject {
  const count = options.things ?? 50
  const seed = options.seed ?? 'opmd'
  const duplicates = options.duplicates ?? 2
  const products: FakeResource = {
    id: 1,
    name: 'prodotti',
    label: 'Prodotti',
    fields: [
      { id: 11, name: 'nome', type: 'string', textual: true, label: 'Nome' },
      { id: 12, name: 'foto', type: 'image', label: 'Foto principale' },
      { id: 13, name: 'galleria', type: 'image', label: 'Galleria' },
    ],
  }
  const sheets: FakeResource = {
    id: 2,
    name: 'schede',
    label: 'Schede tecniche',
    fields: [
      {
        id: 21,
        name: 'titolo',
        type: 'string',
        textual: true,
        label: 'Titolo',
      },
      {
        id: 22,
        name: 'pdf',
        type: 'file',
        translatable: true,
        label: 'Scheda PDF',
      },
    ],
  }
  const things: FakeThing[] = []
  for (let i = 1; i <= count; i++) {
    const photo: FakeFile = {
      token: token(`${seed}-photo-${i}`),
      name: `prodotto-${i}.jpg`,
      size: 2000 + (i % 7) * 100,
      width: 1200,
      height: 900,
    }
    const gallery: FakeFile[] = [
      {
        token: token(`${seed}-gal-${i}-a`),
        name: `prodotto-${i}-retro.jpg`,
        size: 1500,
      },
      // Same content as the photo, another name: one download, two names
      {
        token: photo.token,
        name: `prodotto-${i}-copertina.jpg`,
        size: photo.size,
      },
    ]
    things.push({
      id: 1000 + i,
      resource_id: 1,
      label: `Prodotto ${i}`,
      files: { foto: [photo], galleria: gallery },
      updated_at: STAMP,
    })
  }
  for (let i = 1; i <= Math.max(1, Math.round(count / 5)); i++) {
    things.push({
      id: 5000 + i,
      resource_id: 2,
      label: `Scheda ${i}`,
      files: {
        pdf: {
          it: [
            {
              token: token(`${seed}-pdf-${i}-it`),
              name: `scheda-${i}-it.pdf`,
              size: 4000,
            },
          ],
          en: [
            {
              token: token(`${seed}-pdf-${i}-en`),
              name: `scheda-${i}-en.pdf`,
              size: 4100,
            },
          ],
        },
      },
      updated_at: STAMP,
    })
  }
  // Duplicates: the same name (different case) for different contents
  for (let d = 1; d <= duplicates; d++) {
    const target = things[d - 1]
    const gallery = target.files.galleria as FakeFile[]
    gallery.push({
      token: token(`${seed}-dup-${d}`),
      name: `PRODOTTO-${d}.JPG`,
      size: 999,
    })
  }
  return {
    id: 77,
    label: 'Progetto di prova',
    langs: ['it', 'en'],
    resources: [products, sheets],
    things,
  }
}

/* ------------------------------------------------------------------ standalone */

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 ? process.argv[index + 1] ?? fallback : fallback
}

async function main(): Promise<void> {
  const port = Number(arg('port', '4310'))
  const things = Number(arg('things', '3000'))
  const fake = await startFakeOnPage({
    project: sampleProject({
      things,
      duplicates: Number(arg('duplicates', '3')),
    }),
    token: arg('token', 'fake-token'),
    port,
  })
  const files = fake.project.things.reduce(
    (sum, t) =>
      sum +
      Object.values(t.files).reduce(
        (s, v) =>
          s + (Array.isArray(v) ? v.length : Object.values(v).flat().length),
        0,
      ),
    0,
  )
  console.log(`Fake On Page on ${fake.url}`)
  console.log(`  token:  ${fake.token}`)
  console.log(`  things: ${fake.project.things.length}, files: ${files}`)
  console.log(`  start the app with OPMD_API_DOMAIN=${fake.url}`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href == import.meta.url) {
  main().catch(error => {
    console.error(error)
    process.exit(1)
  })
}
