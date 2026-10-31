import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JobError } from './errors'
import { RetryPolicy } from './http'
import { listRemote } from './listing'
import { resolveNames } from './names'
import { OnPageContext, verifyToken } from './onpage'
import { countFiles, readIndexCache, writeIndexCache } from './remote-index'
import {
  FakeFile,
  FakeOnPage,
  sampleProject,
  startFakeOnPage,
  token,
} from './testing/fake-onpage-server'
import { cleanupTempDirs, tempDir } from './testing/tmp'

const FAST: RetryPolicy = {
  attempts: 3,
  base_delay_ms: 5,
  max_delay_ms: 20,
  max_retry_after_ms: 50,
}

let fake: FakeOnPage

function ctx(onRetry?: OnPageContext['onRetry']): OnPageContext {
  return {
    fetch: (url, init) => fetch(url, init),
    domain: fake.url,
    policy: FAST,
    timeout_ms: 5000,
    onRetry,
  }
}

beforeEach(async () => {
  fake = await startFakeOnPage({
    project: sampleProject({ things: 30, duplicates: 2 }),
  })
})

afterEach(async () => {
  await fake.close()
})

afterAll(cleanupTempDirs)

describe('listing', () => {
  it('reads every media field, every language, in small pages', async () => {
    const pages: number[] = []
    const result = await listRemote({
      token: fake.token,
      ctx: ctx(),
      page_size: 7,
      onProgress: p => pages.push(p.things_read),
    })
    expect(result).toMatchObject({
      complete: true,
      mode: 'full',
      failed_resources: [],
    })
    // 30 products × (photo + 2 gallery) + 2 duplicates, 6 sheets × (it + en)
    expect(countFiles(result.index)).toBe(30 * 3 + 2 + 6 * 2)
    const sheets = result.index.resources.find(r => r.id == 2)!
    const langs = Array.from(sheets.things.values())
      .flat()
      .map(t => t[1])
    expect(new Set(langs)).toEqual(new Set(['it', 'en']))
    expect(Math.max(...pages)).toBe(36)
    const resolved = resolveNames(result.index)
    expect(resolved.duplicates).toHaveLength(2)
  })

  it('incremental: only new and changed things are read; gone things are dropped', async () => {
    const first = await listRemote({ token: fake.token, ctx: ctx() })
    const cache_file = path.join(await tempDir(), 'cache.json.gz')
    await writeIndexCache(cache_file, first.index)
    const cache = await readIndexCache(cache_file)
    expect(cache).toBeDefined()

    // On Page changes: a photo replaced, a product deleted, a product added
    const changed = fake.project.things.find(t => t.id == 1005)!
    const replaced: FakeFile = {
      token: token('replaced'),
      name: 'prodotto-5.jpg',
      size: 77,
    }
    changed.files.foto = [replaced]
    fake.touch(1005)
    fake.project.things = fake.project.things.filter(t => t.id != 1006)
    fake.project.things.push({
      id: 1999,
      resource_id: 1,
      files: { foto: [{ token: token('new'), name: 'nuovo.jpg', size: 5 }] },
      updated_at: '2026-01-01 00:00:00',
    })

    let read = 0
    const second = await listRemote({
      token: fake.token,
      ctx: ctx(),
      cache,
      onProgress: p => (read = p.things_read),
    })
    expect(second.mode).toBe('incremental')
    expect(read).toBe(2)
    const products = second.index.resources.find(r => r.id == 1)!
    expect(products.things.get(1005)![0][3]).toBe(replaced.token)
    expect(products.things.has(1006)).toBe(false)
    expect(products.things.has(1999)).toBe(true)
  })

  it('a different token or schema means a full listing', async () => {
    const first = await listRemote({ token: fake.token, ctx: ctx() })
    const tampered = { ...first.index, signature: 'other' }
    const second = await listRemote({
      token: fake.token,
      ctx: ctx(),
      cache: tampered,
    })
    expect(second.mode).toBe('full')
    const old = {
      ...first.index,
      checkpoint: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
    }
    expect(
      (await listRemote({ token: fake.token, ctx: ctx(), cache: old })).mode,
    ).toBe('full')
  })

  it('429 waits and goes on', async () => {
    fake.api.rate_limit_times = 2
    fake.api.retry_after_s = 0
    const retries: number[] = []
    const result = await listRemote({
      token: fake.token,
      ctx: ctx((error: any) => retries.push(error.status)),
    })
    expect(result.complete).toBe(true)
    expect(retries).toEqual([429, 429])
  })

  it('a collection that keeps failing makes the listing incomplete, not empty', async () => {
    fake.api.fail_resource = 'schede'
    const result = await listRemote({ token: fake.token, ctx: ctx() })
    expect(result.complete).toBe(false)
    expect(result.failed_resources.map(r => r.id)).toEqual([2])
    expect(result.index.resources.find(r => r.id == 1)!.things.size).toBe(30)
  })

  it('a refused token ends the listing as token_invalid', async () => {
    await expect(
      listRemote({ token: 'wrong', ctx: ctx() }),
    ).rejects.toMatchObject({ issue: 'token_invalid' })
  })

  it('no server at all is «offline»', async () => {
    const closed = { ...ctx(), domain: 'http://127.0.0.1:9' }
    const error = await listRemote({ token: fake.token, ctx: closed }).catch(
      e => e,
    )
    expect(error).toBeInstanceOf(JobError)
    expect(error.issue).toBe('offline')
  })

  it('verifies a token for the new project form', async () => {
    expect(await verifyToken(fake.token, ctx())).toEqual({
      ok: true,
      project_label: 'Progetto di prova',
      collections_with_files: 2,
      langs: ['it', 'en'],
    })
    expect(await verifyToken('wrong', ctx())).toEqual({
      ok: false,
      error: 'token_invalid',
    })
  })
})
