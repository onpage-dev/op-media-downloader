import { promises as fs } from 'fs'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ActivityLog, FailedList } from './activity'
import { executePlan } from './executor'
import { RetryPolicy } from './http'
import { LinkCapability } from './link'
import { Manifest } from './manifest'
import { DesiredFile, nameKey } from './names'
import { storageLinker } from './onpage'
import { buildPlan } from './plan'
import { ProgressTracker } from './progress'
import { scanFolder } from './scan'
import {
  FakeFile,
  fileContent,
  FakeOnPage,
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

let fake: FakeOnPage
const files: FakeFile[] = []

/** Registers files on the fake storage (one thing per file) */
function serve(...list: FakeFile[]): FakeFile[] {
  for (const file of list) {
    files.push(file)
    fake.project.things.push({
      id: 100 + files.length,
      resource_id: 1,
      files: { foto: [file] },
      updated_at: '2026-01-01 00:00:00',
    })
  }
  return list
}

function want(file: FakeFile, name = file.name): DesiredFile {
  return {
    key: nameKey(name),
    local_name: name,
    remote_name: file.name,
    token: file.token,
    size: file.size,
    use: { resource_id: 1, thing_id: 1, field_id: 12, lang: null },
  }
}

async function run(
  desired: DesiredFile[],
  options: {
    folder?: string
    abortAfterMs?: number
    capability?: LinkCapability
    idle_ms?: number
    beforeExecute?: (folder: string) => Promise<void>
  } = {},
): Promise<{
  folder: string
  result: Awaited<ReturnType<typeof executePlan>>
  failed: FailedList
  activity: ActivityLog
  manifest: Manifest
  rate_limited: number
}> {
  const folder = options.folder ?? (await tempDir())
  const data_dir = path.join(folder, 'data')
  await fs.mkdir(data_dir, { recursive: true })
  const { manifest } = await Manifest.load(data_dir, 'p')
  const plan = buildPlan({
    desired,
    manifest,
    scan: await scanFolder(folder),
    keep_old_files: false,
    listing_complete: true,
    listing: 'full',
  })
  await options.beforeExecute?.(folder)
  const controller = new AbortController()
  if (options.abortAfterMs !== undefined)
    setTimeout(() => controller.abort(), options.abortAfterMs)
  const failed = new FailedList()
  const activity = new ActivityLog()
  let rate_limited = 0
  const result = await executePlan({
    folder,
    data_dir,
    manifest,
    plan,
    fetch: (url, init) => fetch(url, init),
    storageUrl: storageLinker(fake.url),
    concurrency: 4,
    signal: controller.signal,
    progress: new ProgressTracker({ total: 0, bytes_total: 0, concurrency: 4 }),
    activity,
    failed,
    capability: options.capability ?? {},
    policy: FAST,
    headers_timeout_ms: 1000,
    idle_timeout_ms: options.idle_ms ?? 300,
    onRateLimited: () => rate_limited++,
  })
  await manifest.flush()
  return { folder, result, failed, activity, manifest, rate_limited }
}

beforeAll(async () => {
  fake = await startFakeOnPage({
    project: { id: 1, label: 'x', langs: ['it'], resources: [], things: [] },
  })
})

afterAll(async () => {
  await fake.close()
  await cleanupTempDirs()
})

describe('downloads', () => {
  it('one content under two names is downloaded once and linked twice', async () => {
    const [file] = serve({ token: token('shared'), name: 'a.jpg', size: 3000 })
    const { folder, result, manifest } = await run([
      want(file, 'a.jpg'),
      want(file, 'b.jpg'),
    ])
    expect(fake.hits.storage.get(file.token)).toBe(1)
    expect(result.downloaded).toBe(2)
    const a = await fs.stat(path.join(folder, 'a.jpg'), { bigint: true })
    const b = await fs.stat(path.join(folder, 'b.jpg'), { bigint: true })
    const blob = await fs.stat(path.join(folder, 'data', file.token), {
      bigint: true,
    })
    expect(a.ino).toBe(blob.ino)
    expect(b.ino).toBe(blob.ino)
    expect(await fs.readFile(path.join(folder, 'a.jpg'))).toEqual(
      fileContent(file),
    )
    expect(manifest.get('a.jpg')).toMatchObject({
      token: file.token,
      mode: 'link',
    })
    expect(await listDir(path.join(folder, 'data'))).toEqual(
      [file.token, 'manifest.json'].sort(),
    )
  })

  it('500 and connection resets are retried', async () => {
    const [flaky, reset] = serve(
      { token: token('flaky'), name: 'flaky.jpg', size: 100 },
      { token: token('reset'), name: 'reset.jpg', size: 100 },
    )
    fake.storage.set(flaky.token, { fail_times: 2 })
    fake.storage.set(reset.token, { reset_times: 1 })
    const { result, failed } = await run([want(flaky), want(reset)])
    expect(result.downloaded).toBe(2)
    expect(failed.list()).toEqual([])
    expect(fake.hits.storage.get(flaky.token)).toBe(3)
  })

  it('404 is final: one attempt, «not_found»', async () => {
    const [gone] = serve({ token: token('gone'), name: 'gone.jpg', size: 100 })
    fake.storage.set(gone.token, { missing: true })
    const { result, failed, folder } = await run([want(gone)])
    expect(result.failed).toBe(1)
    expect(failed.list()[0]).toMatchObject({
      name: 'gone.jpg',
      reason: 'not_found',
      attempts: 1,
    })
    expect(fake.hits.storage.get(gone.token)).toBe(1)
    expect(await listDir(path.join(folder, 'data'))).toEqual([])
  })

  it('a server that stops sending times out instead of hanging (D8)', async () => {
    const [mute] = serve({ token: token('mute'), name: 'mute.jpg', size: 100 })
    fake.storage.set(mute.token, { mute: true })
    const started = Date.now()
    const { failed, folder } = await run([want(mute)], { idle_ms: 200 })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(failed.list()[0]).toMatchObject({
      reason: 'timeout',
      attempts: FAST.attempts,
    })
    expect(
      (await listDir(path.join(folder, 'data'))).filter(n =>
        n.endsWith('.download'),
      ),
    ).toEqual([])
  })

  it('429 waits (Retry-After) and retries', async () => {
    const [busy] = serve({ token: token('busy'), name: 'busy.jpg', size: 100 })
    fake.storage.set(busy.token, { rate_limit_times: 1, retry_after_s: 0 })
    const { result, rate_limited } = await run([want(busy)])
    expect(result.downloaded).toBe(1)
    expect(rate_limited).toBe(1)
  })

  it('a wrong size is not accepted', async () => {
    const [wrong] = serve({
      token: token('wrong'),
      name: 'wrong.jpg',
      size: 100,
      content: Buffer.alloc(60, 1),
    })
    const { failed, folder } = await run([want(wrong)])
    expect(failed.list()[0]).toMatchObject({ reason: 'size_mismatch' })
    expect(await listDir(folder)).toEqual(['data'])
  })

  it('stop: transfers abort and no temporary file is left (D8)', async () => {
    const list = serve(
      ...Array.from({ length: 6 }, (_, i) => ({
        token: token(`slow-${i}`),
        name: `slow-${i}.jpg`,
        size: 100,
      })),
    )
    for (const file of list) fake.storage.set(file.token, { delay_ms: 2000 })
    const started = Date.now()
    const { failed, folder, activity } = await run(
      list.map(f => want(f)),
      { abortAfterMs: 150 },
    )
    expect(Date.now() - started).toBeLessThan(1500)
    expect(failed.list()).toEqual([])
    expect(activity.recent().every(e => e.outcome != 'downloaded')).toBe(true)
    expect(
      (await listDir(path.join(folder, 'data'))).filter(n =>
        n.endsWith('.download'),
      ),
    ).toEqual([])
  })

  it('a file that appeared after the plan is never overwritten: conflict', async () => {
    const [file] = serve({ token: token('late'), name: 'late.jpg', size: 100 })
    const { failed, folder } = await run([want(file)], {
      beforeExecute: folder =>
        fs.writeFile(path.join(folder, 'late.jpg'), 'mio file'),
    })
    expect(failed.list()[0]).toMatchObject({
      name: 'late.jpg',
      reason: 'name_conflict',
    })
    expect(await fs.readFile(path.join(folder, 'late.jpg'), 'utf8')).toBe(
      'mio file',
    )
  })

  it('where links are not possible the content is copied', async () => {
    const [file] = serve({ token: token('copy'), name: 'copy.jpg', size: 500 })
    const { result, manifest, folder } = await run(
      [want(file), want(file, 'copy-2.jpg')],
      { capability: { hardlinks: false } },
    )
    expect(result.copies).toBe(2)
    expect(manifest.get('copy.jpg')?.mode).toBe('copy')
    const a = await fs.stat(path.join(folder, 'copy.jpg'), { bigint: true })
    const blob = await fs.stat(path.join(folder, 'data', file.token), {
      bigint: true,
    })
    expect(a.ino).not.toBe(blob.ino)
    expect(await fs.readFile(path.join(folder, 'copy-2.jpg'))).toEqual(
      fileContent(file),
    )
  })
})
