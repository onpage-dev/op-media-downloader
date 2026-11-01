import { existsSync, promises as fs } from 'fs'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeleteFilesResult, EngineProject, EngineToMain } from '../shared/engine-protocol'
import { DuplicatePage, FailedPage, ProjectRuntime, SyncResult } from '../shared/models'
import { Engine, EngineTimings } from './engine'
import { RetryPolicy } from './http'
import {
  FakeFile,
  fileContent,
  FakeOnPage,
  FakeProject,
  FakeThing,
  sampleProject,
  startFakeOnPage,
  token,
} from './testing/fake-onpage-server'
import { cleanupTempDirs, listDir, tempDir } from './testing/tmp'

const FAST: RetryPolicy = {
  attempts: 3,
  base_delay_ms: 5,
  max_delay_ms: 20,
  max_retry_after_ms: 50,
}
const TIMINGS: Partial<EngineTimings> = {
  state_interval_ms: 5,
  activity_interval_ms: 5,
  api_policy: FAST,
  download_policy: FAST,
  api_timeout_ms: 5000,
  headers_timeout_ms: 2000,
  idle_timeout_ms: 1000,
  page_size: 7,
  reach_timeout_ms: 3000,
}

let fake: FakeOnPage
let engine: Engine
let messages: EngineToMain[]
let cache_dir: string

function project(folder: string, extra: Partial<EngineProject> = {}): EngineProject {
  return {
    id: 'p1',
    label: 'Prova',
    token: fake.token,
    folder,
    keep_old_files: false,
    ...extra,
  }
}

async function run(command: Parameters<Engine['command']>[0]): Promise<SyncResult> {
  const before = messages.length
  engine.command(command)
  await engine.idle()
  const result = messages
    .slice(before)
    .filter(m => m.kind == 'result')
    .pop()
  if (!result || result.kind != 'result') throw new Error('No result')
  return result.result
}

function lastState(): ProjectRuntime {
  const state = messages.filter(m => m.kind == 'state').pop()
  if (!state || state.kind != 'state') throw new Error('No state')
  return state.runtime
}

function lastResult(): SyncResult {
  const result = messages.filter(m => m.kind == 'result').pop()
  if (!result || result.kind != 'result') throw new Error('No result')
  return result.result
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error('Timed out')
    await sleep(5)
  }
}

/** The phases sent from message `from` on */
function phasesSince(from: number): string[] {
  return messages
    .slice(from)
    .map(m => (m.kind == 'state' ? m.runtime.phase : ''))
    .filter(Boolean)
}

let request_id = 0
async function ask<T>(request: Parameters<Engine['request']>[1]): Promise<T> {
  const id = ++request_id
  await engine.request(id, request)
  const response = messages.find(m => m.kind == 'response' && m.request_id == id)
  if (!response || response.kind != 'response') throw new Error('No response')
  if (!response.ok) throw new Error(response.error)
  return response.data as T
}

/** Every file the sample project serves, by name as the folder will show it */
function remoteNames(): Map<string, FakeFile> {
  const out = new Map<string, FakeFile>()
  for (const thing of fake.project.things) {
    for (const value of Object.values(thing.files)) {
      for (const file of Array.isArray(value) ? value : Object.values(value).flat()) {
        const key = file.name.toLowerCase()
        if (!Array.from(out.keys()).some(k => k.toLowerCase() == key)) out.set(file.name, file)
      }
    }
  }
  return out
}

function storageHits(): number {
  return Array.from(fake.hits.storage.values()).reduce((a, b) => a + b, 0)
}

beforeEach(async () => {
  fake = await startFakeOnPage({
    project: sampleProject({ things: 20, duplicates: 2 }),
  })
  messages = []
  cache_dir = await tempDir('opmd-cache-')
  engine = new Engine({
    fetch: (url, init): Promise<Response> => fetch(url, init),
    post: (m): void => {
      messages.push(m)
    },
    timings: TIMINGS,
  })
  engine.command({
    type: 'init',
    init: {
      cache_dir,
      project_folders: [],
      concurrency: 4,
      app_version: 'test',
      instance_id: 'test-instance',
      api_domain: fake.url,
    },
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await engine.idle()
  await fake.close()
})

afterAll(cleanupTempDirs)

describe('engine: the core flow', () => {
  it('sync → download → sync again (nothing) → a file leaves On Page (only ours removed)', async () => {
    const folder = path.join(await tempDir(), 'Catalogo')
    const names = remoteNames()

    // «Sincronizza»: plan only
    let result = await run({ type: 'sync', project: project(folder) })
    expect(result).toMatchObject({ job: 'sync', outcome: 'completed' })
    let runtime = lastState()
    expect(runtime.phase).toBe('idle')
    expect(runtime.plan).toMatchObject({
      listing: 'full',
      duplicates: 2,
      to_download_names: names.size,
      cleanup_needs_confirmation: false,
    })
    expect(runtime.issues.map(i => i.code)).toEqual(['duplicates'])
    const phases = messages.filter(m => m.kind == 'state').map(m => (m.kind == 'state' ? m.runtime.phase : ''))
    expect(phases).toEqual(expect.arrayContaining(['preparing', 'listing', 'comparing', 'idle']))
    // Nothing written yet: «Sincronizza» leaves no trace in the folder
    expect(await listDir(folder)).toEqual([])

    // «Scarica»
    result = await run({ type: 'download', project: project(folder) })
    expect(result).toMatchObject({
      job: 'download',
      outcome: 'completed',
      failed: 0,
      downloaded: names.size,
    })
    for (const [name, file] of names) expect(await fs.readFile(path.join(folder, name))).toEqual(fileContent(file))
    // A content shared by two names was downloaded once
    const tokens = new Set(Array.from(names.values()).map(f => f.token))
    expect(storageHits()).toBe(tokens.size)
    runtime = lastState()
    expect(runtime.plan).toMatchObject({
      to_download: 0,
      to_link: 0,
      to_remove: 0,
    })

    // A file of the user in the same folder
    await fs.writeFile(path.join(folder, 'appunti.docx'), 'mio')

    // Nothing changed on On Page: nothing to do, nothing downloaded, incremental listing
    const hits = storageHits()
    result = await run({ type: 'sync', project: project(folder) })
    expect(result).toMatchObject({
      outcome: 'completed',
      downloaded: 0,
      linked: 0,
      removed: 0,
      already_present: names.size,
    })
    expect(lastState().plan).toMatchObject({
      listing: 'incremental',
      to_download: 0,
      to_link: 0,
      to_remove: 0,
    })
    expect(storageHits()).toBe(hits)

    // A product leaves On Page: its three names go, the user's file stays
    fake.project.things = fake.project.things.filter(t => t.id != 1010)
    result = await run({ type: 'sync', project: project(folder) })
    expect(result).toMatchObject({ outcome: 'completed', removed: 3 })
    const left = await listDir(folder)
    expect(left).not.toContain('prodotto-10.jpg')
    expect(left).not.toContain('prodotto-10-retro.jpg')
    expect(left).toContain('appunti.docx')
    expect(await fs.readFile(path.join(folder, 'appunti.docx'), 'utf8')).toBe('mio')

    // Activity and duplicates for the inspector
    const activity = await ask<{ outcome: string }[]>({
      type: 'get_activity',
      project_id: 'p1',
    })
    expect(activity.some(a => a.outcome == 'removed')).toBe(true)
    const page = await ask<DuplicatePage>({
      type: 'get_duplicates',
      project: project(folder),
    })
    expect(page).toMatchObject({ total: 2, language_variants: 0 })
    const duplicates = page.groups
    expect(duplicates).toHaveLength(2)
    expect(duplicates[0].variants[0]).toMatchObject({ chosen: true })
    expect(duplicates[0].variants[0].uses[0]).toMatchObject({
      resource_label: 'Prodotti',
      field_label: 'Foto principale',
    })
    expect(duplicates[0].variants[0].uses[0].thing_label).toBe('Prodotto 1')
    expect(duplicates[0].variants[0].uses[0].edit_url).toMatch(/#\/things\/edit\/1001\/77\/1\/12$/)

    // Deleting the project's files: only ours, the folder stays for the user's file
    const deleted = await ask<DeleteFilesResult>({
      type: 'delete_project_files',
      project: project(folder),
    })
    expect(deleted).toMatchObject({ removed_folder: false, kept_entries: 1 })
    expect(await listDir(folder)).toEqual(['appunti.docx'])
  })

  it('files renamed or replaced on On Page arrive with the incremental listing (`_updated_at`)', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    await run({ type: 'download', project: project(folder) })
    const thing = (id: number): FakeThing => fake.project.things.find(t => t.id == id)!

    // Renamed (same content), also in a translatable field: linked again, nothing downloaded
    const photo = (thing(1003).files.foto as FakeFile[])[0]
    photo.name = 'prodotto-3-fronte.jpg'
    const sheets = thing(5001).files.pdf as Record<string, FakeFile[]>
    sheets.en[0].name = 'scheda-1-en-v2.pdf'
    fake.touch(1003)
    fake.touch(5001)
    const hits = storageHits()
    let result = await run({ type: 'sync', project: project(folder) })
    expect(lastState().plan).toMatchObject({
      listing: 'incremental',
      to_download: 0,
    })
    expect(result).toMatchObject({
      outcome: 'completed',
      downloaded: 0,
      linked: 2,
      removed: 2,
    })
    expect(storageHits()).toBe(hits)
    const names = await listDir(folder)
    expect(names).toEqual(
      expect.arrayContaining(['prodotto-3-fronte.jpg', 'prodotto-3-copertina.jpg', 'scheda-1-en-v2.pdf']),
    )
    expect(names).not.toContain('prodotto-3.jpg')
    expect(names).not.toContain('scheda-1-en.pdf')
    expect(await fs.readFile(path.join(folder, 'prodotto-3-fronte.jpg'))).toEqual(fileContent(photo))

    // Replaced (same name, new content): downloaded, the old content leaves data/
    const gallery = thing(1004).files.galleria as FakeFile[]
    const old_token = gallery[0].token
    gallery[0] = {
      token: token('retro-4-nuovo'),
      name: 'prodotto-4-retro.jpg',
      size: 1600,
    }
    fake.touch(1004)
    await run({ type: 'sync', project: project(folder) })
    expect(lastState().plan).toMatchObject({
      listing: 'incremental',
      to_download: 1,
      to_download_names: 1,
    })
    result = await run({ type: 'download', project: project(folder) })
    expect(result).toMatchObject({
      outcome: 'completed',
      downloaded: 1,
      failed: 0,
    })
    expect(await fs.readFile(path.join(folder, 'prodotto-4-retro.jpg'))).toEqual(fileContent(gallery[0]))
    expect(await listDir(path.join(folder, 'data'))).not.toContain(old_token)
  })

  it('duplicates come a page at a time, by name, also after a restart; translated files with one name are counted', async () => {
    // The Italian and the English datasheet of one item uploaded with the same name
    const sheets = fake.project.things.find(t => t.id == 5001)!.files.pdf as Record<string, FakeFile[]>
    sheets.en[0].name = sheets.it[0].name
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    const page = (extra: object): Promise<DuplicatePage> =>
      ask<DuplicatePage>({
        type: 'get_duplicates',
        project: project(folder),
        ...extra,
      })
    const first = await page({ offset: 0, limit: 2 })
    expect(first).toMatchObject({ total: 3, language_variants: 1 })
    expect(first.groups.map(g => g.name)).toEqual(['prodotto-1.jpg', 'prodotto-2.jpg'])
    expect((await page({ offset: 2, limit: 2 })).groups.map(g => g.name)).toEqual(['scheda-1-it.pdf'])
    const found = await page({ offset: 0, limit: 50, query: ' SCHEDA ' })
    expect(found.total).toBe(1)
    expect(found.groups[0].variants.map(v => v.uses[0].lang)).toEqual(['it', 'en'])

    // A new engine (the app restarted): the names come from the listing cache
    const restarted = new Engine({
      fetch: (url, init): Promise<Response> => fetch(url, init),
      post: (m): void => {
        messages.push(m)
      },
      timings: TIMINGS,
    })
    restarted.command({
      type: 'init',
      init: {
        cache_dir,
        project_folders: [],
        concurrency: 4,
        app_version: 'test',
        instance_id: 'test-restarted',
        api_domain: fake.url,
      },
    })
    await restarted.request(9999, {
      type: 'get_duplicates',
      project: project(folder),
      offset: 0,
      limit: 50,
    })
    const response = messages.find(m => m.kind == 'response' && m.request_id == 9999)
    expect(response).toMatchObject({ ok: true, data: { total: 3 } })
  })

  it('a folder from 1.x is taken over without downloading or removing anything', async () => {
    const folder = await tempDir()
    const data = path.join(folder, 'data')
    await fs.mkdir(data)
    const names = remoteNames()
    const link_json: Record<string, string> = {}
    let i = 0
    for (const [name, file] of names) {
      const blob = path.join(data, file.token)
      if (!existsSync(blob)) await fs.writeFile(blob, fileContent(file))
      await fs.link(blob, path.join(folder, name))
      // An interrupted 1.1.7 session wrote link.json only for some names
      if (i++ % 3) link_json[name] = file.token
    }
    await fs.writeFile(path.join(data, 'link.json'), JSON.stringify(link_json))
    await fs.writeFile(path.join(folder, 'mio.txt'), 'utente')

    const result = await run({ type: 'sync', project: project(folder) })
    expect(result).toMatchObject({
      outcome: 'completed',
      downloaded: 0,
      removed: 0,
      failed: 0,
    })
    expect(storageHits()).toBe(0)
    expect(lastState().plan).toMatchObject({
      to_download: 0,
      to_remove: 0,
      conflicts: 0,
    })
    const manifest = JSON.parse(await fs.readFile(path.join(data, 'manifest.json'), 'utf8'))
    expect(Object.keys(manifest.files)).toHaveLength(names.size)
    expect(await fs.readFile(path.join(folder, 'mio.txt'), 'utf8')).toBe('utente')
  })

  it('many removals wait for a confirmation', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    await run({ type: 'download', project: project(folder) })
    // 18 of 20 products leave On Page: 54 names
    fake.project.things = fake.project.things.filter(t => t.resource_id != 1 || t.id > 1018)
    let result = await run({ type: 'sync', project: project(folder) })
    expect(result.removed).toBe(0)
    let runtime = lastState()
    expect(runtime.plan).toMatchObject({
      cleanup_needs_confirmation: true,
      to_remove: 54,
    })
    expect(runtime.issues.map(i => i.code)).toContain('cleanup_needs_confirmation')
    expect(await listDir(folder)).toContain('prodotto-1.jpg')
    result = await run({ type: 'confirm_cleanup', project: project(folder) })
    expect(result).toMatchObject({ job: 'cleanup', removed: 54 })
    expect(await listDir(folder)).not.toContain('prodotto-1.jpg')
    runtime = lastState()
    expect(runtime.issues.map(i => i.code)).not.toContain('cleanup_needs_confirmation')
  })

  it('stop: the run ends quickly, nothing half-written, the rest stays to download', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    for (const file of remoteNames().values()) fake.storage.set(file.token, { delay_ms: 1500 })
    engine.command({ type: 'download', project: project(folder) })
    await new Promise(resolve => setTimeout(resolve, 300))
    const started = Date.now()
    engine.command({ type: 'stop', project_id: 'p1' })
    await engine.idle()
    expect(Date.now() - started).toBeLessThan(1500)
    const result = messages.filter(m => m.kind == 'result').pop()
    expect(result?.kind == 'result' && result.result.outcome).toBe('stopped')
    expect((await listDir(path.join(folder, 'data'))).filter(n => n.endsWith('.download'))).toEqual([])
    expect(lastState().plan!.to_download_names).toBeGreaterThan(0)
    expect(lastState().phase).toBe('idle')
  })

  it('failures are listed and «Riprova i falliti» fixes them', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    const broken = remoteNames().get('prodotto-3.jpg')!
    fake.storage.set(broken.token, { fail_times: 10 })
    const result = await run({ type: 'download', project: project(folder) })
    // The content is shared by two names
    expect(result.failed).toBe(2)
    expect(lastState().issues.find(i => i.code == 'failed_files')?.count).toBe(2)
    const failed = await ask<FailedPage>({
      type: 'get_failed',
      project_id: 'p1',
    })
    expect(failed.total).toBe(2)
    expect(failed.entries.map(f => f.reason)).toEqual(['http_error', 'http_error'])
    fake.storage.set(broken.token, {})
    const retry = await run({ type: 'retry_failed', project: project(folder) })
    expect(retry).toMatchObject({
      job: 'retry_failed',
      downloaded: 2,
      failed: 0,
    })
    expect(lastState().issues.map(i => i.code)).not.toContain('failed_files')
    expect(await listDir(folder)).toContain('prodotto-3.jpg')
  })

  it('errors end the job with the right issue', async () => {
    const folder = await tempDir()
    let result = await run({
      type: 'sync',
      project: project(folder, { token: 'wrong' }),
    })
    expect(result).toMatchObject({
      outcome: 'failed',
      error: { code: 'token_invalid', severity: 'error' },
    })
    expect(lastState().issues.map(i => i.code)).toEqual(['token_invalid'])

    result = await run({
      type: 'sync',
      project: project('\\\\10.255.255.1\\media\\vasi'),
    })
    expect(result.error?.code).toBe(process.platform == 'win32' ? 'folder_unreachable' : result.error?.code)

    result = await run({
      type: 'sync',
      project: project(path.parse(folder).root),
    })
    expect(result.error?.code).toBe('folder_protected')

    await fs.mkdir(path.join(folder, 'data'), { recursive: true })
    await fs.writeFile(
      path.join(folder, 'data', '.lock'),
      JSON.stringify({
        host: 'altro-pc',
        pid: 1,
        instance_id: 'other',
        project_id: 'p1',
        started_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
      }),
    )
    result = await run({ type: 'sync', project: project(folder) })
    expect(result.error).toMatchObject({
      code: 'folder_locked',
      detail: 'altro-pc (pid 1)',
    })
  })

  it('answers the folder and token checks of the new project form', async () => {
    const folder = await tempDir()
    const info = await ask<{ exists: boolean; problems: string[] }>({
      type: 'inspect_folder',
      path: folder,
    })
    expect(info).toMatchObject({ exists: true, problems: [] })
    expect(await ask({ type: 'verify_token', token: fake.token })).toMatchObject({
      ok: true,
      project_id: 77,
      project_label: 'Progetto di prova',
      collections_with_files: 2,
    })
  })
})

describe('one On Page project per folder', () => {
  /** Another project on On Page: another id, other files (some with the same names) */
  const otherProject = (): FakeProject => ({
    ...sampleProject({ things: 6, duplicates: 0, seed: 'altro' }),
    id: 88,
    label: 'Altro progetto',
  })
  const registry = async (folder: string): Promise<{ onpage_project?: unknown }> =>
    JSON.parse(await fs.readFile(path.join(folder, 'data', 'manifest.json'), 'utf8'))

  it('the first files name the project in the folder; a renamed project gets its new label', async () => {
    const folder = await tempDir()
    let result = await run({ type: 'sync', project: project(folder) })
    expect(result.onpage_project).toBeUndefined()
    expect(await listDir(folder)).toEqual([])
    result = await run({ type: 'download', project: project(folder) })
    expect(result.onpage_project).toEqual({ id: 77, label: 'Progetto di prova' })
    expect((await registry(folder)).onpage_project).toEqual({ id: 77, label: 'Progetto di prova' })

    fake.project.label = 'Catalogo 2027'
    result = await run({ type: 'sync', project: project(folder) })
    expect(result).toMatchObject({ outcome: 'completed', onpage_project: { id: 77, label: 'Catalogo 2027' } })
    expect((await registry(folder)).onpage_project).toEqual({ id: 77, label: 'Catalogo 2027' })
    expect(await ask({ type: 'inspect_folder', path: folder })).toMatchObject({
      onpage_project: { id: 77, label: 'Catalogo 2027' },
    })
  })

  it('a token of another project stops before touching anything; the choice of the user takes the folder over', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    await run({ type: 'download', project: project(folder) })
    const before = await listDir(folder)
    const hits = storageHits()

    fake.project = otherProject()
    for (const type of ['sync', 'download', 'confirm_cleanup'] as const) {
      const result = await run({ type, project: project(folder) })
      expect(result).toMatchObject({
        outcome: 'failed',
        error: { code: 'folder_other_project', detail: 'Progetto di prova' },
      })
      expect(result.onpage_project).toBeUndefined()
    }
    expect(lastState().issues.map(i => i.code)).toContain('folder_other_project')
    expect(await listDir(folder)).toEqual(before)
    expect(storageHits()).toBe(hits)
    expect((await registry(folder)).onpage_project).toMatchObject({ id: 77 })

    // A new project, another token or another folder: the folder is this project's from its sync on
    let result = await run({ type: 'sync', project: project(folder, { take_over_folder: true }) })
    expect(result).toMatchObject({ outcome: 'completed', onpage_project: { id: 88, label: 'Altro progetto' } })
    expect((await registry(folder)).onpage_project).toEqual({ id: 88, label: 'Altro progetto' })
    // The names of the old project go with the download, under the usual threshold; the shared ones are replaced
    expect(lastState().plan).toMatchObject({ cleanup_needs_confirmation: false })
    expect(lastState().plan?.to_remove).toBeGreaterThan(0)
    result = await run({ type: 'download', project: project(folder) })
    expect(result).toMatchObject({ outcome: 'completed', failed: 0 })
    const names = remoteNames()
    expect(await listDir(folder)).toEqual(['data', ...names.keys()].sort())
    for (const [name, file] of names) expect(await fs.readFile(path.join(folder, name))).toEqual(fileContent(file))
  })

  it('deleting the files is refused when the folder is another project’s now', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    await run({ type: 'download', project: project(folder) })
    const before = await listDir(folder)
    // The project last synced another On Page project there: the folder was taken over since
    await expect(
      ask({ type: 'delete_project_files', project: project(folder, { onpage_project_id: 88 }) }),
    ).rejects.toThrow(/^folder_other_project: Progetto di prova/)
    expect(await listDir(folder)).toEqual(before)
    await ask({ type: 'delete_project_files', project: project(folder, { onpage_project_id: 77 }) })
    expect(existsSync(folder)).toBe(false)
  })
})

const UNC_ROOT = process.platform == 'win32' ? '\\\\localhost\\' : ''
const smb = UNC_ROOT && existsSync(UNC_ROOT + 'C$')

describe.runIf(smb)('engine on a network folder (SMB loopback)', () => {
  it('the same flow through \\\\localhost\\C$', async () => {
    const local = await tempDir()
    const folder = UNC_ROOT + local.replace(/^([A-Z]):/i, '$1$') + '\\Rete'
    await run({ type: 'sync', project: project(folder) })
    const result = await run({ type: 'download', project: project(folder) })
    expect(result).toMatchObject({ outcome: 'completed', failed: 0 })
    const names = remoteNames()
    expect((await listDir(folder)).filter(n => n != 'data')).toHaveLength(names.size)
    const again = await run({ type: 'sync', project: project(folder) })
    expect(again).toMatchObject({ downloaded: 0, linked: 0, removed: 0 })
  })
})

describe('a data folder the user already had', () => {
  it('is never used by a sync nor touched by deleting the project', async () => {
    const folder = await tempDir()
    await fs.mkdir(path.join(folder, 'data'))
    await fs.writeFile(path.join(folder, 'data', 'bilancio.xlsx'), 'mio')

    const result = await run({ type: 'sync', project: project(folder) })
    expect(result.outcome).toBe('failed')
    expect(result.error?.code).toBe('folder_protected')
    expect(storageHits()).toBe(0)

    const info = await ask<{ problems: string[] }>({ type: 'inspect_folder', path: folder })
    expect(info.problems).toContain('foreign_data')

    await ask<DeleteFilesResult>({ type: 'delete_project_files', project: project(folder) })
    expect(await listDir(path.join(folder, 'data'))).toEqual(['bilancio.xlsx'])
  })
})

describe('removals above the threshold', () => {
  /** Products `from`..`to` leave On Page (three names each) */
  const leave = (from: number, to: number): void => {
    fake.project.things = fake.project.things.filter(t => t.resource_id != 1 || t.id < 1000 + from || t.id > 1000 + to)
  }

  it('a confirmation sent while another job runs is not kept for later', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    await run({ type: 'download', project: project(folder) })
    fake.api.delay_ms = 100
    engine.command({ type: 'sync', project: project(folder) })
    engine.command({ type: 'confirm_cleanup', project: project(folder) })
    await engine.idle()
    fake.api.delay_ms = 0
    // 18 of 20 products leave On Page: 54 names nobody confirmed
    leave(1, 18)
    const result = await run({ type: 'sync', project: project(folder) })
    expect(result.removed).toBe(0)
    expect(lastState().plan).toMatchObject({
      cleanup_needs_confirmation: true,
      to_remove: 54,
    })
    expect(await listDir(folder)).toContain('prodotto-1.jpg')
  })

  it('a confirmation removes the names the user saw, also with downloads pending; what leaves later waits again', async () => {
    fake.project = sampleProject({ things: 60, duplicates: 0 })
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    await run({ type: 'download', project: project(folder) })
    // 20 of 60 products leave (60 names), a new one arrives
    leave(1, 20)
    fake.project.things.push({
      id: 1999,
      resource_id: 1,
      files: { foto: [{ token: token('nuovo'), name: 'nuovo.jpg', size: 500 }] },
      updated_at: '2026-01-01 00:00:00',
    })
    await run({ type: 'sync', project: project(folder) })
    expect(lastState().plan).toMatchObject({
      to_download: 1,
      cleanup_needs_confirmation: true,
      to_remove: 60,
    })
    let result = await run({ type: 'confirm_cleanup', project: project(folder) })
    expect(result).toMatchObject({
      job: 'cleanup',
      outcome: 'completed',
      removed: 60,
      downloaded: 0,
    })
    expect(await listDir(folder)).not.toContain('prodotto-1.jpg')
    expect(lastState().plan).toMatchObject({
      to_download: 1,
      cleanup_needs_confirmation: false,
      to_remove: 0,
    })

    // 20 more leave: the confirmation was for the first ones only
    leave(21, 40)
    await run({ type: 'sync', project: project(folder) })
    result = await run({ type: 'download', project: project(folder) })
    expect(result).toMatchObject({
      outcome: 'completed',
      downloaded: 1,
      removed: 0,
    })
    expect(lastState().plan).toMatchObject({
      cleanup_needs_confirmation: true,
      to_remove: 60,
    })
    expect(lastState().issues.find(i => i.code == 'cleanup_needs_confirmation')?.count).toBe(60)
    expect(await listDir(folder)).toEqual(expect.arrayContaining(['prodotto-21.jpg', 'nuovo.jpg']))
  })
})

describe('the listing', () => {
  it('collections that cannot be read: «listing incomplete» names them, nothing is removed; a complete listing clears it', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    await run({ type: 'download', project: project(folder) })
    fake.project.things = fake.project.things.filter(t => t.id != 1010)
    fake.api.fail_resource = 'schede'
    let result = await run({ type: 'sync', project: project(folder) })
    expect(result).toMatchObject({ outcome: 'completed', removed: 0 })
    expect(lastState().issues).toContainEqual(
      expect.objectContaining({
        code: 'listing_incomplete',
        severity: 'warning',
        detail: 'Schede tecniche',
      }),
    )
    expect(await listDir(folder)).toContain('prodotto-10.jpg')

    fake.api.fail_resource = undefined
    result = await run({ type: 'sync', project: project(folder) })
    expect(result).toMatchObject({ outcome: 'completed', removed: 3 })
    expect(lastState().issues.map(i => i.code)).not.toContain('listing_incomplete')
  })

  it('the names kept for the duplicates tab are dropped after listing_max_age_ms', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    // After a restart: the names come from the listing cache on disk
    const restarted = new Engine({
      fetch: (url, init): Promise<Response> => fetch(url, init),
      post: (m): void => {
        messages.push(m)
      },
      timings: { ...TIMINGS, listing_max_age_ms: 200 },
    })
    restarted.command({
      type: 'init',
      init: {
        cache_dir,
        project_folders: [],
        concurrency: 4,
        app_version: 'test',
        instance_id: 'test-restarted',
        api_domain: fake.url,
      },
    })
    const reads = vi.spyOn(fs, 'readFile')
    const cacheReads = (): number => reads.mock.calls.filter(([file]) => String(file).startsWith(cache_dir)).length
    const page = { type: 'get_duplicates', project: project(folder) } as const
    await restarted.request(9001, page)
    await restarted.request(9002, { ...page, offset: 1 })
    // Kept between two pages
    expect(cacheReads()).toBe(1)
    await sleep(300)
    await restarted.request(9003, page)
    expect(cacheReads()).toBe(2)
    expect(messages.filter(m => m.kind == 'response' && m.request_id > 9000)).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({ ok: true, data: expect.objectContaining({ total: 2 }) }),
      ),
    )
  })
})

describe('stop', () => {
  it('is quick while a lock that looks stale is watched; the phase stays «stopping»', async () => {
    const folder = await tempDir()
    await fs.mkdir(path.join(folder, 'data'))
    const old = new Date(Date.now() - 10 * 60_000).toISOString()
    await fs.writeFile(
      path.join(folder, 'data', '.lock'),
      JSON.stringify({
        host: 'altro-pc',
        pid: 1,
        instance_id: 'other',
        project_id: 'p1',
        started_at: old,
        heartbeat_at: old,
      }),
    )
    engine.command({ type: 'sync', project: project(folder) })
    await sleep(200)
    const at = messages.length
    const started = Date.now()
    engine.command({ type: 'stop', project_id: 'p1' })
    await engine.idle()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(lastResult().outcome).toBe('stopped')
    const phases = phasesSince(at)
    expect(phases[0]).toBe('stopping')
    expect(phases.filter(p => p != 'stopping' && p != 'idle')).toEqual([])
  })

  it('is quick while the folder does not answer', async () => {
    const folder = await tempDir()
    const root = path.parse(folder).root
    const stat = fs.stat
    vi.spyOn(fs, 'stat').mockImplementation(((file: string, ...rest: []) =>
      path.resolve(String(file)) == path.resolve(root)
        ? new Promise(() => undefined)
        : stat(file, ...rest)) as typeof fs.stat)
    engine.command({ type: 'sync', project: project(folder) })
    await sleep(100)
    const started = Date.now()
    engine.command({ type: 'stop', project_id: 'p1' })
    await engine.idle()
    // The reach timeout of these tests is 3 s
    expect(Date.now() - started).toBeLessThan(1000)
    expect(lastResult().outcome).toBe('stopped')
  })

  it('what is left comes from the plan, without reading the folder again', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    for (const file of remoteNames().values()) fake.storage.set(file.token, { delay_ms: 1500 })
    engine.command({ type: 'download', project: project(folder) })
    await waitFor(() => storageHits() >= 1)
    const readdir = vi.spyOn(fs, 'readdir')
    engine.command({ type: 'stop', project_id: 'p1' })
    await engine.idle()
    expect(lastResult().outcome).toBe('stopped')
    expect(readdir).not.toHaveBeenCalled()
    expect(lastState().plan).toMatchObject({
      to_download_names: remoteNames().size,
      up_to_date: 0,
    })
  })
})

describe('conflicts', () => {
  it('a name taken while the run works is one more conflict, the same count in the plan and in the issues', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    const { link, writeFile } = fs
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      // Another program creates the file right before the app links it
      if (String(to).endsWith('prodotto-5.jpg') && !existsSync(to)) await writeFile(to, 'mio')
      return link(from, to)
    })
    const result = await run({ type: 'download', project: project(folder) })
    expect(result).toMatchObject({ outcome: 'completed', failed: 0 })
    expect(lastState().plan?.conflicts).toBe(1)
    expect(lastState().issues.find(i => i.code == 'name_conflicts')?.count).toBe(1)
    expect(await fs.readFile(path.join(folder, 'prodotto-5.jpg'), 'utf8')).toBe('mio')
  })
})

describe('commands and requests while a job runs', () => {
  it('a second job of the project is ignored', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    for (const file of remoteNames().values()) fake.storage.set(file.token, { delay_ms: 100 })
    const at = messages.length
    engine.command({ type: 'download', project: project(folder) })
    engine.command({ type: 'sync', project: project(folder) })
    await engine.idle()
    const results = messages.slice(at).filter(m => m.kind == 'result')
    expect(results).toHaveLength(1)
    expect(lastResult()).toMatchObject({ job: 'download', outcome: 'completed' })
    expect(messages.slice(at).some(m => m.kind == 'log' && m.level == 'warn' && /ignored/.test(m.message))).toBe(true)
  })

  it('forget: the job stops, nothing more is sent for the project, its folder is free again', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    for (const file of remoteNames().values()) fake.storage.set(file.token, { delay_ms: 300 })
    engine.command({ type: 'download', project: project(folder) })
    await waitFor(() => storageHits() >= 1)
    const at = messages.length
    engine.command({ type: 'forget', project_id: 'p1' })
    await engine.idle()
    expect(messages.slice(at).filter(m => m.kind == 'state' || m.kind == 'result' || m.kind == 'activity')).toEqual([])
    for (const file of remoteNames().values()) fake.storage.set(file.token, {})
    expect(await run({ type: 'download', project: project(folder) })).toMatchObject({
      outcome: 'completed',
      failed: 0,
    })
  })

  it('deleting the files is refused while a job runs (project busy); the job goes on', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    for (const file of remoteNames().values()) fake.storage.set(file.token, { delay_ms: 100 })
    engine.command({ type: 'download', project: project(folder) })
    await waitFor(() => storageHits() >= 1)
    await expect(ask({ type: 'delete_project_files', project: project(folder) })).rejects.toThrow('project_busy')
    await engine.idle()
    expect(lastResult()).toMatchObject({
      job: 'download',
      outcome: 'completed',
      failed: 0,
    })
    expect(await listDir(folder)).toContain('prodotto-1.jpg')
  })

  it('no job starts while the files are being deleted', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    await run({ type: 'download', project: project(folder) })
    const unlink = fs.unlink
    const removing = vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      await sleep(10)
      return unlink(file)
    })
    const deleting = ask<DeleteFilesResult>({
      type: 'delete_project_files',
      project: project(folder),
    })
    await waitFor(() => removing.mock.calls.length > 0)
    const at = messages.length
    engine.command({ type: 'sync', project: project(folder) })
    const deleted = await deleting
    await engine.idle()
    expect(messages.slice(at).filter(m => m.kind == 'result')).toEqual([])
    expect(deleted).toMatchObject({ removed_folder: true, kept_entries: 0 })
    expect(existsSync(folder)).toBe(false)
  })
})

describe('deleting the files of a project', () => {
  it('holds the lock until data/ is empty and removes it last', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    await run({ type: 'download', project: project(folder) })
    const data = path.join(folder, 'data')
    const lock = path.join(data, '.lock')
    const removed: { name: string; locked: boolean }[] = []
    const record = (file: unknown): void => {
      if (path.dirname(String(file)) == data)
        removed.push({ name: path.basename(String(file)), locked: existsSync(lock) })
    }
    const { rm, unlink } = fs
    vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      record(file)
      return rm(file, options)
    })
    vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      record(file)
      return unlink(file)
    })
    await ask({ type: 'delete_project_files', project: project(folder) })
    expect(removed.at(-1)?.name).toBe('.lock')
    expect(removed.map(r => r.name)).toContain('manifest.json')
    expect(removed.slice(0, -1).filter(r => !r.locked)).toEqual([])
    expect(existsSync(data)).toBe(false)
  })

  it('removes our names also when the disk gives them back decomposed (NFD)', async () => {
    const folder = await tempDir()
    const data = path.join(folder, 'data')
    await fs.mkdir(data)
    const name = 'caffè.jpg'
    const blob = token('caffe')
    await fs.writeFile(path.join(data, blob), 'x')
    await fs.writeFile(path.join(folder, name.normalize('NFD')), 'x')
    await fs.writeFile(
      path.join(data, 'manifest.json'),
      JSON.stringify({
        version: 2,
        project_id: 'p1',
        updated_at: new Date().toISOString(),
        files: { [name]: { token: blob, mode: 'adopted' } },
      }),
    )
    await fs.writeFile(path.join(folder, 'mio.txt'), 'utente')
    const deleted = await ask<DeleteFilesResult>({
      type: 'delete_project_files',
      project: project(folder),
    })
    expect(deleted).toMatchObject({ removed_files: 1, kept_entries: 1 })
    expect(await listDir(folder)).toEqual(['mio.txt'])
  })
})
