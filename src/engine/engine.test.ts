import { existsSync, promises as fs } from 'fs'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DeleteFilesResult,
  EngineProject,
  EngineToMain,
} from '../shared/engine-protocol'
import {
  DuplicatePage,
  FailedPage,
  ProjectRuntime,
  SyncResult,
} from '../shared/models'
import { Engine, EngineTimings } from './engine'
import { RetryPolicy } from './http'
import {
  FakeFile,
  fileContent,
  FakeOnPage,
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

function project(
  folder: string,
  extra: Partial<EngineProject> = {},
): EngineProject {
  return {
    id: 'p1',
    label: 'Prova',
    token: fake.token,
    folder,
    keep_old_files: false,
    ...extra,
  }
}

async function run(
  command: Parameters<Engine['command']>[0],
): Promise<SyncResult> {
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

let request_id = 0
async function ask<T>(request: Parameters<Engine['request']>[1]): Promise<T> {
  const id = ++request_id
  await engine.request(id, request)
  const response = messages.find(
    m => m.kind == 'response' && m.request_id == id,
  )
  if (!response || response.kind != 'response') throw new Error('No response')
  if (!response.ok) throw new Error(response.error)
  return response.data as T
}

/** Every file the sample project serves, by name as the folder will show it */
function remoteNames(): Map<string, FakeFile> {
  const out = new Map<string, FakeFile>()
  for (const thing of fake.project.things) {
    for (const value of Object.values(thing.files)) {
      for (const file of Array.isArray(value)
        ? value
        : Object.values(value).flat()) {
        const key = file.name.toLowerCase()
        if (!Array.from(out.keys()).some(k => k.toLowerCase() == key))
          out.set(file.name, file)
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
    const phases = messages
      .filter(m => m.kind == 'state')
      .map(m => (m.kind == 'state' ? m.runtime.phase : ''))
    expect(phases).toEqual(
      expect.arrayContaining(['preparing', 'listing', 'comparing', 'idle']),
    )
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
    for (const [name, file] of names)
      expect(await fs.readFile(path.join(folder, name))).toEqual(
        fileContent(file),
      )
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
    expect(await fs.readFile(path.join(folder, 'appunti.docx'), 'utf8')).toBe(
      'mio',
    )

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
    expect(duplicates[0].variants[0].uses[0].edit_url).toMatch(
      /#\/things\/edit\/1001\/77\/1\/12$/,
    )

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
    const thing = (id: number): FakeThing =>
      fake.project.things.find(t => t.id == id)!

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
      expect.arrayContaining([
        'prodotto-3-fronte.jpg',
        'prodotto-3-copertina.jpg',
        'scheda-1-en-v2.pdf',
      ]),
    )
    expect(names).not.toContain('prodotto-3.jpg')
    expect(names).not.toContain('scheda-1-en.pdf')
    expect(
      await fs.readFile(path.join(folder, 'prodotto-3-fronte.jpg')),
    ).toEqual(fileContent(photo))

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
    expect(
      await fs.readFile(path.join(folder, 'prodotto-4-retro.jpg')),
    ).toEqual(fileContent(gallery[0]))
    expect(await listDir(path.join(folder, 'data'))).not.toContain(old_token)
  })

  it('duplicates come a page at a time, by name, also after a restart; translated files with one name are counted', async () => {
    // The Italian and the English datasheet of one item uploaded with the same name
    const sheets = fake.project.things.find(t => t.id == 5001)!.files
      .pdf as Record<string, FakeFile[]>
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
    expect(first.groups.map(g => g.name)).toEqual([
      'prodotto-1.jpg',
      'prodotto-2.jpg',
    ])
    expect((await page({ offset: 2, limit: 2 })).groups.map(g => g.name)).toEqual(
      ['scheda-1-it.pdf'],
    )
    const found = await page({ offset: 0, limit: 50, query: ' SCHEDA ' })
    expect(found.total).toBe(1)
    expect(found.groups[0].variants.map(v => v.uses[0].lang)).toEqual([
      'it',
      'en',
    ])

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
    const response = messages.find(
      m => m.kind == 'response' && m.request_id == 9999,
    )
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
    const manifest = JSON.parse(
      await fs.readFile(path.join(data, 'manifest.json'), 'utf8'),
    )
    expect(Object.keys(manifest.files)).toHaveLength(names.size)
    expect(await fs.readFile(path.join(folder, 'mio.txt'), 'utf8')).toBe(
      'utente',
    )
  })

  it('many removals wait for a confirmation', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    await run({ type: 'download', project: project(folder) })
    // 18 of 20 products leave On Page: 54 names
    fake.project.things = fake.project.things.filter(
      t => t.resource_id != 1 || t.id > 1018,
    )
    let result = await run({ type: 'sync', project: project(folder) })
    expect(result.removed).toBe(0)
    let runtime = lastState()
    expect(runtime.plan).toMatchObject({
      cleanup_needs_confirmation: true,
      to_remove: 54,
    })
    expect(runtime.issues.map(i => i.code)).toContain(
      'cleanup_needs_confirmation',
    )
    expect(await listDir(folder)).toContain('prodotto-1.jpg')
    result = await run({ type: 'confirm_cleanup', project: project(folder) })
    expect(result).toMatchObject({ job: 'cleanup', removed: 54 })
    expect(await listDir(folder)).not.toContain('prodotto-1.jpg')
    runtime = lastState()
    expect(runtime.issues.map(i => i.code)).not.toContain(
      'cleanup_needs_confirmation',
    )
  })

  it('stop: the run ends quickly, nothing half-written, the rest stays to download', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    for (const file of remoteNames().values())
      fake.storage.set(file.token, { delay_ms: 1500 })
    engine.command({ type: 'download', project: project(folder) })
    await new Promise(resolve => setTimeout(resolve, 300))
    const started = Date.now()
    engine.command({ type: 'stop', project_id: 'p1' })
    await engine.idle()
    expect(Date.now() - started).toBeLessThan(1500)
    const result = messages.filter(m => m.kind == 'result').pop()
    expect(result?.kind == 'result' && result.result.outcome).toBe('stopped')
    expect(
      (await listDir(path.join(folder, 'data'))).filter(n =>
        n.endsWith('.download'),
      ),
    ).toEqual([])
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
    expect(lastState().issues.find(i => i.code == 'failed_files')?.count).toBe(
      2,
    )
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
    expect(result.error?.code).toBe(
      process.platform == 'win32' ? 'folder_unreachable' : result.error?.code,
    )

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
    expect(
      await ask({ type: 'verify_token', token: fake.token }),
    ).toMatchObject({ ok: true, collections_with_files: 2 })
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
    expect((await listDir(folder)).filter(n => n != 'data')).toHaveLength(
      names.size,
    )
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
