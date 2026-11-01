import { promises as fs } from 'fs'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { ListingResult } from './listing'
import { ListingStore } from './listing-store'
import { resolveNames } from './names'
import { RemoteIndex } from './remote-index'
import { cleanupTempDirs, tempDir } from './testing/tmp'

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(cleanupTempDirs)

const index: RemoteIndex = {
  schema_id: 1,
  signature: 's',
  checkpoint: new Date().toISOString(),
  resources: [
    {
      id: 1,
      things: new Map([
        [1, [[12, null, 'a.jpg', 'tok-a', 1, null, null]]],
        [2, [[12, null, 'A.JPG', 'tok-b', 1, null, null]]],
      ]),
    },
  ],
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function store(max_age_ms: number): Promise<ListingStore> {
  const dir = await tempDir('opmd-cache-')
  return new ListingStore({ cache_dir: () => dir, max_age_ms, now: Date.now })
}

describe('listing store', () => {
  it('keeps a listing for max_age, then drops it', async () => {
    const listings = await store(100)
    const listing = { complete: true, index } as ListingResult
    listings.keep('p1', { token: 't', listing, resolved: resolveNames(index) })
    expect(listings.fresh('p1', 't')?.listing).toBe(listing)
    expect(listings.fresh('p1', 'other token')).toBeUndefined()
    await sleep(150)
    expect(listings.fresh('p1', 't')).toBeUndefined()
    // Nothing on disk either: no names
    expect(await listings.resolved('p1', 't')).toBeUndefined()
  })

  it('names read from the cache are kept between pages, but not while a listing runs', async () => {
    const listings = await store(60_000)
    await listings.writeCache('p1', index)
    const reads = vi.spyOn(fs, 'readFile')
    const cacheReads = (): number =>
      reads.mock.calls.filter(([file]) => String(file) == listings.cacheFile('p1')).length

    listings.begin('p1')
    expect((await listings.resolved('p1', 't'))?.duplicates).toHaveLength(1)
    await listings.resolved('p1', 't')
    expect(cacheReads()).toBe(2)
    listings.end('p1')

    await listings.resolved('p1', 't')
    await listings.resolved('p1', 't')
    expect(cacheReads()).toBe(3)
    // A listing that starts drops them: it brings new ones
    listings.begin('p1')
    await listings.resolved('p1', 't')
    expect(cacheReads()).toBe(4)
  })
})
