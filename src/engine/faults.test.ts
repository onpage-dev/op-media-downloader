/**
 * The core flow (sync → download → files on disk) against the faults of real
 * folders: a full disk, a share that drops, an unplugged disk, a read-only
 * folder, an antivirus or another program holding a file, a file system
 * without hard links, another computer taking the folder. After every fault:
 * nothing half-written under a name, the right issue, and the next run ends
 * the work.
 */
import { existsSync, promises as fs } from 'fs'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineProject, EngineToMain } from '../shared/engine-protocol'
import { ActivityEntry, FailedPage, ProjectRuntime, SyncResult } from '../shared/models'
import { Engine, EngineTimings } from './engine'
import { RetryPolicy } from './http'
import { fakeFreeSpace, FsOp, injectFaults, under } from './testing/faults'
import {
  FakeFile,
  fileContent,
  FakeOnPage,
  sampleProject,
  startFakeOnPage,
  token,
} from './testing/fake-onpage-server'
import { cleanupTempDirs, listDir, tempDir } from './testing/tmp'

const FAST: RetryPolicy = { attempts: 3, base_delay_ms: 5, max_delay_ms: 20, max_retry_after_ms: 50 }
const TIMINGS: Partial<EngineTimings> = {
  state_interval_ms: 5,
  activity_interval_ms: 5,
  api_policy: FAST,
  download_policy: FAST,
  api_timeout_ms: 5000,
  headers_timeout_ms: 2000,
  idle_timeout_ms: 1000,
  page_size: 7,
  reach_timeout_ms: 1000,
  lock_heartbeat_ms: 20,
}
const WINDOWS = process.platform == 'win32'

let fake: FakeOnPage
let engine: Engine
let messages: EngineToMain[]

const project = (folder: string): EngineProject => ({
  id: 'p1',
  label: 'Prova',
  token: fake.token,
  folder,
  keep_old_files: false,
})

async function run(command: Parameters<Engine['command']>[0]): Promise<SyncResult> {
  engine.command(command)
  await engine.idle()
  return lastResult()
}

function lastResult(): SyncResult {
  const result = messages.filter(m => m.kind == 'result').pop()
  if (!result || result.kind != 'result') throw new Error('No result')
  return result.result
}

function lastState(): ProjectRuntime {
  const state = messages.filter(m => m.kind == 'state').pop()
  if (!state || state.kind != 'state') throw new Error('No state')
  return state.runtime
}

const issues = (): string[] => lastState().issues.map(i => i.code)

let request_id = 0
async function ask<T>(request: Parameters<Engine['request']>[1]): Promise<T> {
  const id = ++request_id
  await engine.request(id, request)
  const response = messages.find(m => m.kind == 'response' && m.request_id == id)
  if (!response || response.kind != 'response' || !response.ok) throw new Error('No response')
  return response.data as T
}

/** Every file of the sample project, by the name it gets in the folder */
function remoteNames(): Map<string, FakeFile> {
  const out = new Map<string, FakeFile>()
  for (const thing of fake.project.things) {
    for (const value of Object.values(thing.files)) {
      for (const file of Array.isArray(value) ? value : Object.values(value).flat()) {
        if (!Array.from(out.keys()).some(k => k.toLowerCase() == file.name.toLowerCase())) out.set(file.name, file)
      }
    }
  }
  return out
}

const storageHits = (): number => Array.from(fake.hits.storage.values()).reduce((a, b) => a + b, 0)

async function waitFor(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error('Timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/**
 * The invariants after any fault: a name holds its whole file or is not
 * there, every content in data/ is whole, every name in the manifest exists.
 */
async function checkFolder(folder: string): Promise<void> {
  const by_key = new Map(Array.from(remoteNames()).map(([name, file]) => [name.toLowerCase(), file]))
  for (const name of await listDir(folder)) {
    const file = by_key.get(name.toLowerCase())
    if (file) expect(await fs.readFile(path.join(folder, name)), name).toEqual(fileContent(file))
  }
  const data = path.join(folder, 'data')
  const tokens = new Map(Array.from(remoteNames().values()).map(file => [file.token, file]))
  for (const name of await listDir(data).catch(() => [] as string[])) {
    const file = tokens.get(name)
    if (file) expect(await fs.readFile(path.join(data, name)), `data/${name}`).toEqual(fileContent(file))
  }
  if (existsSync(path.join(data, 'manifest.json'))) {
    const manifest = JSON.parse(await fs.readFile(path.join(data, 'manifest.json'), 'utf8'))
    for (const name of Object.keys(manifest.files)) expect(existsSync(path.join(folder, name)), name).toBe(true)
  }
}

/** Everything is there and whole */
async function checkComplete(folder: string): Promise<void> {
  await checkFolder(folder)
  const names = await listDir(folder)
  for (const name of remoteNames().keys()) expect(names, name).toContain(name)
}

const thing = (id: number) => fake.project.things.find(t => t.id == id)!

beforeEach(async () => {
  fake = await startFakeOnPage({ project: sampleProject({ things: 20, duplicates: 2 }) })
  messages = []
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
      cache_dir: await tempDir('opmd-cache-'),
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

describe('disk full', () => {
  it('in the middle of a download: the run stops, nothing half-written, the next run ends the work', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    const faults = injectFaults([{ op: 'write', path: f => f.endsWith('.download'), code: 'ENOSPC', after: 6 }])
    let freed = false
    fakeFreeSpace(() => (faults.fired.get('write') && !freed ? 4096 : 10e9))
    const result = await run({ type: 'download', project: project(folder) })
    expect(result.outcome).toBe('failed')
    expect(issues()).toContain('disk_full')
    faults.clear()
    freed = true
    expect((await listDir(path.join(folder, 'data'))).filter(n => n.endsWith('.download'))).toEqual([])
    await checkFolder(folder)
    expect(await run({ type: 'download', project: project(folder) })).toMatchObject({ outcome: 'completed', failed: 0 })
    await checkComplete(folder)
  })

  it('checked before starting: not enough room, nothing downloaded', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    fakeFreeSpace(8192)
    expect(await run({ type: 'download', project: project(folder) })).toMatchObject({ outcome: 'failed', downloaded: 0 })
    expect(issues()).toContain('disk_full')
    expect(lastState().issues.find(i => i.code == 'disk_full')?.detail).toMatch(/needed/)
    expect(storageHits()).toBe(0)
  })

  it('a file too big for the disk (FAT32, 4 GB) fails alone; the run goes on', async () => {
    const folder = await tempDir()
    const big = (thing(1003).files.foto as FakeFile[])[0]
    await run({ type: 'sync', project: project(folder) })
    injectFaults([{ op: 'write', path: f => f.includes(big.token), code: 'ENOSPC' }])
    fakeFreeSpace(10e9)
    const result = await run({ type: 'download', project: project(folder) })
    expect(result.outcome).toBe('completed')
    const failed = (await ask<FailedPage>({ type: 'get_failed', project_id: 'p1' })).entries
    expect(failed.map(f => f.reason)).toEqual(['file_too_large', 'file_too_large'])
    expect(failed.map(f => f.name).sort()).toEqual(['prodotto-3-copertina.jpg', 'prodotto-3.jpg'])
    await checkFolder(folder)
    expect(await listDir(folder)).toContain('prodotto-4.jpg')
  })
})

describe('the folder goes away', () => {
  const ALL: FsOp[] = ['open', 'write', 'sync', 'rename', 'link', 'unlink', 'copyFile', 'readFile', 'writeFile', 'stat', 'readdir', 'access', 'rm']

  it.each([
    ['a share that drops (Windows)', 'ECONNRESET'],
    ['a share that stops answering', 'ETIMEDOUT'],
    ['a disk unplugged', 'EIO'],
    ['a disk unplugged (Windows)', 'UNKNOWN'],
    ['a folder deleted', 'ENOENT'],
  ])('%s: «folder unreachable», and the next run ends the work', async (_label, code) => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    for (const file of remoteNames().values()) fake.storage.set(file.token, { delay_ms: 40 })
    const faults = injectFaults()
    engine.command({ type: 'download', project: project(folder) })
    await waitFor(() => storageHits() >= 6)
    for (const op of ALL) faults.add({ op, path: under(folder), code })
    await engine.idle()
    expect(lastResult().outcome).toBe('failed')
    expect(issues()).toContain('folder_unreachable')
    faults.clear()
    await checkFolder(folder)
    for (const file of remoteNames().values()) fake.storage.set(file.token, {})
    // Our own lock, left by the run that could not release it, is taken over
    expect(await run({ type: 'download', project: project(folder) })).toMatchObject({ outcome: 'completed', failed: 0 })
    await checkComplete(folder)
  })

  it('an unreachable folder before starting is reported, not «file list not read»', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    await run({ type: 'download', project: project(folder) })
    injectFaults([{ op: 'readdir', path: f => f.endsWith('data'), code: 'EACCES' }])
    expect((await run({ type: 'sync', project: project(folder) })).outcome).toBe('failed')
    expect(issues()).toEqual(expect.arrayContaining(['folder_not_writable']))
  })
})

describe('read-only folder', () => {
  const WRITES: FsOp[] = ['open', 'writeFile', 'link', 'copyFile', 'rename']

  it('from the start: «folder not writable», nothing written', async () => {
    const folder = await tempDir()
    await fs.mkdir(path.join(folder, 'data'))
    const faults = injectFaults(WRITES.map(op => ({ op, path: under(folder), code: 'EACCES' })))
    expect((await run({ type: 'sync', project: project(folder) })).outcome).toBe('failed')
    expect(issues()).toContain('folder_not_writable')
    faults.clear()
    expect(await listDir(path.join(folder, 'data'))).toEqual([])
  })

  it('during the run (permissions changed): «folder not writable», the next run ends the work', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    for (const file of remoteNames().values()) fake.storage.set(file.token, { delay_ms: 30 })
    const faults = injectFaults()
    engine.command({ type: 'download', project: project(folder) })
    await waitFor(() => storageHits() >= 6)
    for (const op of WRITES) faults.add({ op, path: under(folder), code: 'EACCES' })
    await engine.idle()
    expect(lastResult().outcome).toBe('failed')
    expect(issues()).toContain('folder_not_writable')
    faults.clear()
    await checkFolder(folder)
    expect(await run({ type: 'download', project: project(folder) })).toMatchObject({ outcome: 'completed' })
    await checkComplete(folder)
  })
})

describe('other programs', () => {
  it('an antivirus holding new files for a moment: retried, nothing fails', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    const faults = injectFaults([{ op: 'rename', path: f => /[0-9a-f]{40}$/.test(f), code: 'EBUSY', times: 3 }])
    expect(await run({ type: 'download', project: project(folder) })).toMatchObject({ outcome: 'completed', failed: 0 })
    expect(faults.fired.get('rename')).toBe(3)
    await checkComplete(folder)
  })

  it('a leftover download that cannot be deleted does not block the file', async () => {
    const folder = await tempDir()
    const photo = (thing(1005).files.foto as FakeFile[])[0]
    await run({ type: 'sync', project: project(folder) })
    await fs.mkdir(path.join(folder, 'data'), { recursive: true })
    const stuck = path.join(folder, 'data', `${photo.token}.download`)
    await fs.writeFile(stuck, 'mezzo file')
    injectFaults([{ op: 'unlink', path: f => f == stuck, code: 'EBUSY' }])
    expect(await run({ type: 'download', project: project(folder) })).toMatchObject({ outcome: 'completed', failed: 0 })
    await checkComplete(folder)
  })

  it.runIf(WINDOWS)('a file open in another program is not replaced: «in use», the old file stays whole', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    await run({ type: 'download', project: project(folder) })
    const gallery = thing(1004).files.galleria as FakeFile[]
    const old = gallery[0]
    gallery[0] = { token: token('retro-4-nuovo'), name: 'prodotto-4-retro.jpg', size: 1600 }
    fake.touch(1004)
    const faults = injectFaults([{ op: 'rename', path: f => f.endsWith('prodotto-4-retro.jpg'), code: 'EPERM' }])
    await run({ type: 'sync', project: project(folder) })
    const result = await run({ type: 'download', project: project(folder) })
    expect(result).toMatchObject({ outcome: 'completed', failed: 1 })
    const failed = (await ask<FailedPage>({ type: 'get_failed', project_id: 'p1' })).entries
    expect(failed).toMatchObject([{ name: 'prodotto-4-retro.jpg', reason: 'in_use' }])
    expect(await fs.readFile(path.join(folder, 'prodotto-4-retro.jpg'))).toEqual(fileContent(old))
    faults.clear()
    expect(await run({ type: 'download', project: project(folder) })).toMatchObject({ outcome: 'completed', failed: 0 })
    await checkComplete(folder)
  })

  it.runIf(WINDOWS)('a file open in another program is not removed now: it stays ours, the next run removes it', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    await run({ type: 'download', project: project(folder) })
    fake.project.things = fake.project.things.filter(t => t.id != 1010)
    const faults = injectFaults([{ op: 'unlink', path: f => f.endsWith('prodotto-10.jpg'), code: 'EBUSY' }])
    expect(await run({ type: 'sync', project: project(folder) })).toMatchObject({ outcome: 'completed', removed: 2 })
    const activity = await ask<ActivityEntry[]>({ type: 'get_activity', project_id: 'p1' })
    expect(activity).toContainEqual(expect.objectContaining({ name: 'prodotto-10.jpg', outcome: 'failed', reason: 'in_use' }))
    expect(await listDir(folder)).toContain('prodotto-10.jpg')
    faults.clear()
    expect(await run({ type: 'sync', project: project(folder) })).toMatchObject({ outcome: 'completed', removed: 1 })
    expect(await listDir(folder)).not.toContain('prodotto-10.jpg')
  })
})

describe('what the disk does', () => {
  it('writes that take fewer bytes than given still make whole files', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    const faults = injectFaults()
    faults.shortWrites = 7
    expect(await run({ type: 'download', project: project(folder) })).toMatchObject({ outcome: 'completed', failed: 0 })
    await checkComplete(folder)
  })

  it('a content with too many names (NTFS: 1023) gets a copy for the extra name; the others stay links', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    injectFaults([{ op: 'link', path: f => f.endsWith('prodotto-1-copertina.jpg'), code: 'EMLINK' }])
    expect(await run({ type: 'download', project: project(folder) })).toMatchObject({ outcome: 'completed', failed: 0 })
    const ino = async (name: string): Promise<bigint> => (await fs.stat(path.join(folder, name), { bigint: true })).ino
    const photo = (thing(1001).files.foto as FakeFile[])[0]
    const blob = (await fs.stat(path.join(folder, 'data', photo.token), { bigint: true })).ino
    expect(await ino('prodotto-1.jpg')).toBe(blob)
    expect(await ino('prodotto-1-copertina.jpg')).not.toBe(blob)
    expect(await ino('prodotto-2.jpg')).not.toBe(await ino('prodotto-1.jpg'))
    expect(issues()).not.toContain('copies_instead_of_links')
    await checkComplete(folder)
  })

  it('a disk without hard links (FAT, exFAT): every name is a whole copy, no temporary file left', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    injectFaults([{ op: 'link', path: under(folder), code: WINDOWS ? 'EISDIR' : 'EPERM' }])
    expect(await run({ type: 'download', project: project(folder) })).toMatchObject({ outcome: 'completed', failed: 0 })
    expect(issues()).toContain('copies_instead_of_links')
    expect((await listDir(folder)).filter(n => n.startsWith('.opmd-'))).toEqual([])
    await checkComplete(folder)
  })

  it('temporary names left by a crash are cleared and never become conflicts', async () => {
    const folder = await tempDir()
    await fs.writeFile(path.join(folder, '.opmd-0123456789ab'), 'mezza copia')
    await run({ type: 'sync', project: project(folder) })
    expect(await run({ type: 'download', project: project(folder) })).toMatchObject({ outcome: 'completed', failed: 0 })
    expect((await listDir(folder)).filter(n => n.startsWith('.opmd-'))).toEqual([])
    expect(lastState().plan?.conflicts).toBe(0)
  })
})

describe('the registry of the folder', () => {
  it('a manifest that cannot be read now stops the job, and is left as it is', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    await run({ type: 'download', project: project(folder) })
    const file = path.join(folder, 'data', 'manifest.json')
    const before = await fs.readFile(file)
    const faults = injectFaults([{ op: 'readFile', path: f => f == file, code: 'EBUSY' }])
    expect((await run({ type: 'sync', project: project(folder) })).outcome).toBe('failed')
    expect(issues()).toContain('unexpected')
    faults.clear()
    expect(await fs.readFile(file)).toEqual(before)
  })

  it('a broken manifest (power cut): the names are recognised, nothing removed or downloaded again', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    await run({ type: 'download', project: project(folder) })
    const file = path.join(folder, 'data', 'manifest.json')
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).slice(0, 80))
    const hits = storageHits()
    expect(await run({ type: 'sync', project: project(folder) })).toMatchObject({ outcome: 'completed', downloaded: 0, removed: 0 })
    expect(storageHits()).toBe(hits)
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(Object.keys(manifest.files)).toHaveLength(remoteNames().size)
  })

  it('a manifest that cannot be saved at the end: the run is not «completed», the next one registers the files', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    const faults = injectFaults([{ op: 'open', path: f => /manifest\.json\..*\.tmp$/.test(f), code: 'EIO' }])
    expect((await run({ type: 'download', project: project(folder) })).outcome).toBe('failed')
    faults.clear()
    const hits = storageHits()
    expect(await run({ type: 'sync', project: project(folder) })).toMatchObject({ outcome: 'completed', downloaded: 0 })
    expect(storageHits()).toBe(hits)
    const manifest = JSON.parse(await fs.readFile(path.join(folder, 'data', 'manifest.json'), 'utf8'))
    expect(Object.keys(manifest.files)).toHaveLength(remoteNames().size)
    await checkComplete(folder)
  })
})

describe('another computer', () => {
  it('takes the folder during the run: no more writes, «folder in use», its lock stays', async () => {
    const folder = await tempDir()
    await run({ type: 'sync', project: project(folder) })
    for (const file of remoteNames().values()) fake.storage.set(file.token, { delay_ms: 40 })
    engine.command({ type: 'download', project: project(folder) })
    await waitFor(() => storageHits() >= 4)
    const lock = path.join(folder, 'data', '.lock')
    const theirs = JSON.stringify({
      host: 'altro-pc',
      pid: 4242,
      instance_id: 'altro',
      project_id: 'x',
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
    })
    let done = false
    void engine.idle().then(() => (done = true))
    while (!done) {
      await fs.writeFile(lock, theirs).catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(lastResult().outcome).toBe('failed')
    expect(issues()).toContain('folder_locked')
    expect(JSON.parse(await fs.readFile(lock, 'utf8')).instance_id).toBe('altro')
    expect(storageHits()).toBeLessThan(remoteNames().size)
    await checkFolder(folder)
  })
})
