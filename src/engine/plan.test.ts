import { describe, expect, it } from 'vitest'
import { ManifestEntry } from './manifest'
import { DesiredFile, nameKey } from './names'
import {
  AdoptionStat,
  adoptionCandidates,
  buildPlan,
  ManifestView,
  PlanInput,
} from './plan'
import { EntryType, FolderScan } from './scan'

function want(name: string, token: string, size = 10): DesiredFile {
  return {
    key: nameKey(name),
    local_name: name,
    remote_name: name,
    token,
    size,
    use: { resource_id: 1, thing_id: 1, field_id: 1, lang: null },
  }
}

function manifest(files: Record<string, string | ManifestEntry>): ManifestView {
  const entries = Object.entries(files).map(
    ([name, value]) =>
      [
        name,
        typeof value == 'string' ? { token: value, mode: 'link' } : value,
      ] as [string, ManifestEntry],
  )
  return {
    size: entries.length,
    entries: () => entries,
    byKey: key => entries.find(([name]) => nameKey(name) == key),
  }
}

function scan(
  folder: Record<string, EntryType> | string[],
  tokens: string[] = [],
): FolderScan {
  const entries = new Map<string, { name: string; type: EntryType }>()
  const list = Array.isArray(folder)
    ? folder.map(n => [n, 'file'] as [string, EntryType])
    : Object.entries(folder)
  for (const [name, type] of list) entries.set(nameKey(name), { name, type })
  return {
    entries,
    data_tokens: new Set(tokens),
    data_leftovers: [],
    folder_leftovers: [],
  }
}

function plan(
  input: Partial<PlanInput> & Pick<PlanInput, 'desired' | 'manifest' | 'scan'>,
): ReturnType<typeof buildPlan> {
  return buildPlan({
    keep_old_files: false,
    listing_complete: true,
    listing: 'full',
    ...input,
  })
}

describe('plan: what to download and link', () => {
  it('empty folder: everything to download, one download per content', () => {
    const p = plan({
      desired: [want('a.jpg', 't1'), want('b.jpg', 't1'), want('c.jpg', 't2')],
      manifest: manifest({}),
      scan: scan([]),
    })
    expect(p.downloads.map(d => [d.token, d.names.map(n => n.name)])).toEqual([
      ['t1', ['a.jpg', 'b.jpg']],
      ['t2', ['c.jpg']],
    ])
    expect(p.summary).toMatchObject({
      to_download: 2,
      to_download_names: 3,
      to_link: 0,
      to_remove: 0,
      up_to_date: 0,
    })
  })

  it('up to date folder: nothing to do', () => {
    const p = plan({
      desired: [want('a.jpg', 't1')],
      manifest: manifest({ 'a.jpg': 't1' }),
      scan: scan(['a.jpg'], ['t1']),
    })
    expect(p.downloads).toHaveLength(0)
    expect(p.links).toHaveLength(0)
    expect(p.up_to_date).toBe(1)
  })

  it('a name of ours deleted by hand is linked again from data/', () => {
    const p = plan({
      desired: [want('a.jpg', 't1')],
      manifest: manifest({ 'a.jpg': 't1' }),
      scan: scan([], ['t1']),
    })
    expect(p.links.map(l => l.name)).toEqual(['a.jpg'])
    expect(p.downloads).toHaveLength(0)
  })

  it('a changed file (same name, new content) replaces ours', () => {
    const p = plan({
      desired: [want('a.jpg', 't2')],
      manifest: manifest({ 'a.jpg': 't1' }),
      scan: scan(['a.jpg'], ['t1']),
    })
    expect(p.downloads).toEqual([
      {
        token: 't2',
        size: 10,
        names: [
          { name: 'a.jpg', remote_name: 'a.jpg', size: 10, replace: 'a.jpg' },
        ],
      },
    ])
    expect(p.remove_tokens).toEqual(['t1'])
  })

  it('a relink-only change (token already in data/) is applied without downloads (D17)', () => {
    const p = plan({
      desired: [want('a.jpg', 't2')],
      manifest: manifest({ 'a.jpg': 't1' }),
      scan: scan(['a.jpg'], ['t1', 't2']),
    })
    expect(p.downloads).toHaveLength(0)
    expect(p.links).toEqual([
      {
        name: 'a.jpg',
        remote_name: 'a.jpg',
        size: 10,
        replace: 'a.jpg',
        token: 't2',
      },
    ])
  })

  it('only the case of a name changed: a rename, no download', () => {
    const p = plan({
      desired: [want('Foto.jpg', 't1')],
      manifest: manifest({ 'foto.jpg': 't1' }),
      scan: scan(['foto.jpg'], ['t1']),
    })
    expect(p.renames.map(r => [r.from, r.to])).toEqual([
      ['foto.jpg', 'Foto.jpg'],
    ])
    expect(p.downloads).toHaveLength(0)
  })
})

describe('plan: rule 1, only what the app created is removed', () => {
  it('removes names of ours that left On Page, never other files', () => {
    const p = plan({
      desired: [want('a.jpg', 't1')],
      manifest: manifest({ 'a.jpg': 't1', 'old.jpg': 't9' }),
      scan: scan(
        ['a.jpg', 'old.jpg', 'appunti.docx', 'desktop.ini'],
        ['t1', 't9'],
      ),
    })
    expect(p.remove_names).toEqual(['old.jpg'])
    expect(p.remove_tokens).toEqual(['t9'])
  })

  it('a name of ours that disappeared from disk is just forgotten', () => {
    const p = plan({
      desired: [],
      manifest: manifest({ 'gone.jpg': 't1' }),
      scan: scan([], ['t1']),
    })
    expect(p.remove_names).toEqual([])
    expect(p.drop_entries).toEqual(['gone.jpg'])
    expect(p.remove_tokens).toEqual(['t1'])
  })

  it('never removes a name that differs only in case from a wanted one', () => {
    const p = plan({
      desired: [want('A.jpg', 't1')],
      manifest: manifest({ 'A.jpg': 't1', 'a.jpg': 't1' }),
      scan: scan(['A.jpg'], ['t1']),
    })
    expect(p.remove_names).toEqual([])
  })

  it('a manifest name now occupied by a folder is forgotten, not removed', () => {
    const p = plan({
      desired: [],
      manifest: manifest({ x: 't1' }),
      scan: scan({ x: 'dir' }, ['t1']),
    })
    expect(p.remove_names).toEqual([])
    expect(p.drop_entries).toEqual(['x'])
  })

  it('keep_old_files: nothing is removed, contents still referenced stay', () => {
    const p = plan({
      desired: [want('a.jpg', 't1')],
      manifest: manifest({ 'a.jpg': 't1', 'old.jpg': 't9' }),
      scan: scan(['a.jpg', 'old.jpg'], ['t1', 't9', 'orphan']),
      keep_old_files: true,
    })
    expect(p.remove_names).toEqual([])
    expect(p.remove_tokens).toEqual(['orphan'])
  })
})

describe('plan: rule 2, unknown files are never overwritten', () => {
  const desired = [want('a.jpg', 't1', 100)]
  const disk = scan(['a.jpg'], ['t1'])

  it('a user file with the same name is a conflict', () => {
    const adoption = new Map<string, AdoptionStat>([
      ['a.jpg', { name_ino: 5n, name_size: 7, blob_ino: 9n }],
    ])
    const p = plan({ desired, manifest: manifest({}), scan: disk, adoption })
    expect(p.conflicts.map(c => c.name)).toEqual(['a.jpg'])
    expect(p.downloads).toHaveLength(0)
    expect(p.links).toHaveLength(0)
  })

  it('the same file as data/<token> (1.x hard link) is adopted', () => {
    const adoption = new Map<string, AdoptionStat>([
      ['a.jpg', { name_ino: 9n, name_size: 1, blob_ino: 9n }],
    ])
    const p = plan({ desired, manifest: manifest({}), scan: disk, adoption })
    expect(p.adoptions).toEqual([
      {
        name: 'a.jpg',
        token: 't1',
        size: 100,
        mode: 'link',
        remote_name: 'a.jpg',
      },
    ])
    expect(p.conflicts).toHaveLength(0)
    expect(p.up_to_date).toBe(1)
  })

  it('a file with exactly the expected size is adopted', () => {
    const adoption = new Map<string, AdoptionStat>([
      ['a.jpg', { name_ino: 5n, name_size: 100 }],
    ])
    const p = plan({
      desired,
      manifest: manifest({}),
      scan: scan(['a.jpg']),
      adoption,
    })
    expect(p.adoptions[0].mode).toBe('adopted')
    expect(p.downloads).toHaveLength(0)
  })

  it('a folder with a wanted name is a conflict', () => {
    const p = plan({
      desired,
      manifest: manifest({}),
      scan: scan({ 'a.jpg': 'dir' }),
    })
    expect(p.conflicts.map(c => c.name)).toEqual(['a.jpg'])
  })

  it('adoption candidates are only unknown files', () => {
    const candidates = adoptionCandidates(
      [want('a.jpg', 't1'), want('b.jpg', 't2'), want('c.jpg', 't3')],
      manifest({ 'b.jpg': 't2' }),
      scan(['a.jpg', 'b.jpg'], []),
    )
    expect(candidates.map(c => c.name)).toEqual(['a.jpg'])
  })
})

describe('plan: rules 3 and 4, removals that wait or never happen', () => {
  const many: Record<string, string> = {}
  for (let i = 0; i < 100; i++) many[`f${i}.jpg`] = `t${i}`
  const files = Object.keys(many)

  it('more than 50 names and 25% of the manifest: withheld until confirmed', () => {
    const p = plan({
      desired: [want('f0.jpg', 't0')],
      manifest: manifest(many),
      scan: scan(files, Object.values(many)),
    })
    expect(p.remove_names).toEqual([])
    expect(p.withheld_removals).toBe(99)
    expect(p.summary).toMatchObject({
      cleanup_needs_confirmation: true,
      to_remove: 99,
    })
    // Contents of withheld names stay
    expect(p.remove_tokens).toEqual([])
    const confirmed = plan({
      desired: [want('f0.jpg', 't0')],
      manifest: manifest(many),
      scan: scan(files, Object.values(many)),
      cleanup_confirmed: true,
    })
    expect(confirmed.remove_names).toHaveLength(99)
  })

  it('50 names or fewer are removed without asking', () => {
    const desired = files.slice(0, 50).map(f => want(f, many[f]))
    const p = plan({
      desired,
      manifest: manifest(many),
      scan: scan(files, Object.values(many)),
    })
    expect(p.remove_names).toHaveLength(50)
    expect(p.withheld_removals).toBe(0)
  })

  it('an incomplete listing removes nothing, names or contents', () => {
    const p = plan({
      desired: [want('f0.jpg', 't0')],
      manifest: manifest(many),
      scan: scan(files, [...Object.values(many), 'orphan']),
      listing_complete: false,
    })
    expect(p.remove_names).toEqual([])
    expect(p.remove_tokens).toEqual([])
  })
})

describe('plan: performance (no quadratic costs)', () => {
  it('plans 100,000 files in less than 2 seconds', () => {
    const n = 100_000
    const desired: DesiredFile[] = []
    const files: Record<string, string> = {}
    const names: string[] = []
    const tokens: string[] = []
    for (let i = 0; i < n; i++) {
      const name = `Prodotto-${i}-vista.jpg`
      desired.push(want(name, `tok${i}`))
      if (i % 2 == 0) {
        files[name] = `tok${i}`
        names.push(name)
        tokens.push(`tok${i}`)
      }
    }
    // Old names of ours that left On Page
    for (let i = 0; i < 5000; i++) {
      files[`vecchio-${i}.jpg`] = `old${i}`
      names.push(`vecchio-${i}.jpg`)
      tokens.push(`old${i}`)
    }
    const m = manifest(files)
    const index = new Map(m.entries().map(e => [nameKey(e[0]), e]))
    const fast: ManifestView = {
      size: m.size,
      entries: m.entries,
      byKey: key => index.get(key),
    }
    const started = performance.now()
    const p = plan({ desired, manifest: fast, scan: scan(names, tokens) })
    const elapsed = performance.now() - started
    expect(p.downloads).toHaveLength(n / 2)
    expect(p.up_to_date).toBe(n / 2)
    expect(p.remove_names).toHaveLength(5000)
    expect(elapsed).toBeLessThan(2000)
  })
})
