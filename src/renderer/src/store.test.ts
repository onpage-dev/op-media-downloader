/**
 * The page's state (store.ts) on a stand-in of the app (`window.desktop`) that
 * records what the page asks: the long lists a page at a time, the item
 * names that follow the rows, «Mostra altri», a tab left and found again, a
 * list that a run makes stale, searches that overtake each other, the
 * selection and the filters, the toasts.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { DesktopApi } from '@shared/desktop-api'
import type {
  DuplicateGroup,
  DuplicatePage,
  DuplicateVariant,
  DuplicateVariants,
  PageQuery,
  ProjectView,
  VariantsQuery,
} from '@shared/models'
import type { PagedList } from './store'

/** What the page asked, in order */
const calls: string[] = []
/** The project's duplicate names, as the service has them */
let groups: DuplicateGroup[] = []
/** Answers held back until released: a slow On Page */
const held = new Map<string, () => void>()

const hold = (key: string): Promise<void> =>
  key && held.has(key) ? new Promise(resolve => held.set(key, resolve)) : Promise.resolve()
const release = (key: string): void => held.get(key)?.()

function variant(g: number, v: number): DuplicateVariant {
  return {
    token: `t${g}-${v}`,
    chosen: v == 0,
    uses: [
      {
        resource_label: 'Prodotti',
        field_label: 'Foto',
        thing_id: g * 1000 + v,
        thing_label: `Item ${g}-${v}`,
        edit_url: 'https://app.onpage.it/#/things',
      },
    ],
  }
}
const group = (g: number, files: number): DuplicateGroup => ({
  name: `name-${g}.jpg`,
  variants: Array.from({ length: files }, (_, v) => variant(g, v)),
})
/** As the service answers without the labels: the rows at once */
const bare = (v: DuplicateVariant): DuplicateVariant => ({
  ...v,
  uses: v.uses.map(use => ({ ...use, thing_label: undefined })),
})

const fake = {
  platform: 'win32',
  sync: {
    async getDuplicates(_id: string, page: PageQuery): Promise<DuplicatePage> {
      calls.push(`duplicates ${page.offset} ${page.labels ? 'labels' : 'rows'}${page.query ? ` ${page.query}` : ''}`)
      await hold(page.query ?? (page.labels ? `labels ${page.offset}` : ''))
      const all = groups.filter(g => !page.query || g.name.includes(page.query))
      const shown = all.slice(page.offset, page.offset + page.limit).map(g => ({
        name: g.name,
        variants: g.variants.slice(0, 10).map(v => (page.labels ? v : bare(v))),
        more_variants: Math.max(0, g.variants.length - 10),
      }))
      return { total: all.length, language_variants: 0, groups: shown, labels_pending: !page.labels }
    },
    async getDuplicateVariants(_id: string, query: VariantsQuery): Promise<DuplicateVariants> {
      calls.push(`files ${query.name} ${query.offset} ${query.labels ? 'labels' : 'rows'}`)
      const all = groups.find(g => g.name == query.name)?.variants ?? []
      const end = Math.min(all.length, query.offset + query.limit)
      const variants = all.slice(query.offset, end).map(v => (query.labels ? v : bare(v)))
      return { variants, more_variants: all.length - end, labels_pending: !query.labels }
    },
    async getFailed(_id: string, page: PageQuery) {
      calls.push(`failed ${page.offset}`)
      return { total: 0, entries: [] }
    },
    getActivity: async () => [],
  },
  app: { log: () => undefined },
}
// The page's only way to the app; theme and language (the document) are not part of these tests
Object.assign(globalThis, { window: { desktop: fake as unknown as DesktopApi } })

const { app, loadMore, moveSelection, notify, searchDuplicates, select, showMoreVariants, visible } =
  await import('./store')

/**
 * Lets the watchers and the answers run: all of them are promises (Vue's
 * scheduler, the stand-in's answers), so turns of the microtask queue, not
 * timers (15 ms each on Windows)
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

function project(id: string, label = id): ProjectView {
  return {
    id,
    label,
    folder: `D:\\${label}`,
    keep_old_files: false,
    created_at: `2026-11-0${id.length}T00:00:00.000Z`,
    has_token: true,
    runtime: { phase: 'idle', issues: [] },
  } as unknown as ProjectView
}

const list = (): PagedList<DuplicateGroup> => app.duplicates['a']
const labelOf = (g: DuplicateGroup, v = 0): string | undefined => g.variants[v]?.uses[0]?.thing_label

async function openDuplicates(): Promise<void> {
  select('a')
  app.tab = 'duplicates'
  await settle()
}

beforeEach(async () => {
  app.tab = 'general'
  app.selectedId = undefined
  await settle()
  app.ready = true
  app.filter = 'all'
  app.query = ''
  app.projects = [project('a', 'Alfa'), project('bb', 'Beta'), project('ccc', 'Gamma')]
  app.duplicates = {}
  app.toasts = []
  groups = [group(0, 250), ...Array.from({ length: 119 }, (_, g) => group(g + 1, 2 + (g % 3)))]
  held.clear()
  calls.length = 0
})

describe('the duplicates tab', () => {
  it('draws a page at once and its item names after', async () => {
    await openDuplicates()
    expect(calls).toEqual(['duplicates 0 rows', 'duplicates 0 labels'])
    expect(list().items).toHaveLength(50)
    expect(list().total).toBe(120)
    expect(labelOf(list().items[3])).toBe('Item 3-0')

    await loadMore('duplicates', 'a')
    await settle()
    expect(list().items).toHaveLength(100)
    expect(calls.slice(2)).toEqual(['duplicates 50 rows', 'duplicates 50 labels'])
    expect(labelOf(list().items[70])).toBe('Item 70-0')
  })

  it('shows the rows before On Page answers the names', async () => {
    held.set('labels 0', () => undefined)
    await openDuplicates()
    expect(list().items).toHaveLength(50)
    expect(labelOf(list().items[0])).toBeUndefined()
    release('labels 0')
    await settle()
    expect(labelOf(list().items[0])).toBe('Item 0-0')
  })

  it('opens a name with many files a hundred at a time, once per click', async () => {
    await openDuplicates()
    const first = (): DuplicateGroup => list().items[0]
    expect([first().variants.length, first().more_variants]).toEqual([10, 240])
    // Two clicks before the answer: one hundred more, not two
    await Promise.all([showMoreVariants('a', 'name-0.jpg'), showMoreVariants('a', 'name-0.jpg')])
    await settle()
    expect([first().variants.length, first().more_variants]).toEqual([110, 140])
    expect(first().variants[105].token).toBe('t0-105')
    expect(labelOf(first(), 105)).toBe('Item 0-105')
    await showMoreVariants('a', 'name-0.jpg')
    await showMoreVariants('a', 'name-0.jpg')
    await settle()
    expect([first().variants.length, first().more_variants]).toEqual([250, 0])
    // Nothing more to ask
    const asked = calls.length
    await showMoreVariants('a', 'name-0.jpg')
    expect(calls).toHaveLength(asked)
  })

  it('keeps the files opened when the names of the page arrive after them', async () => {
    held.set('labels 0', () => undefined)
    await openDuplicates()
    await showMoreVariants('a', 'name-0.jpg')
    await settle()
    release('labels 0')
    await settle()
    const first = list().items[0]
    expect(first.variants).toHaveLength(110)
    expect(labelOf(first, 0)).toBe('Item 0-0')
    expect(labelOf(first, 100)).toBe('Item 0-100')
  })

  it('comes back without asking again, at the first page with the names closed', async () => {
    await openDuplicates()
    await loadMore('duplicates', 'a')
    await showMoreVariants('a', 'name-0.jpg')
    await settle()
    expect(list().items).toHaveLength(100)
    calls.length = 0

    app.tab = 'general'
    await settle()
    app.tab = 'duplicates'
    await settle()
    expect(calls).toEqual([])
    expect(list().items).toHaveLength(50)
    expect([list().items[0].variants.length, list().items[0].more_variants]).toEqual([10, 240])
  })

  it('loads again a list a run made stale while another tab was shown', async () => {
    await openDuplicates()
    app.tab = 'general'
    await settle()
    calls.length = 0
    // A job ends: the project has a new last result
    app.projects = app.projects.map(p =>
      p.id == 'a' ? { ...p, runtime: { ...p.runtime, last_result: { ended_at: '2026-11-12T08:00:00.000Z' } } } : p,
    ) as ProjectView[]
    await settle()
    expect(calls).toEqual([])
    expect(list().stale).toBe(true)
    app.tab = 'duplicates'
    await settle()
    expect(calls).toEqual(['duplicates 0 rows', 'duplicates 0 labels'])
    expect(list().stale).toBe(false)
  })

  it('shows the last search typed, whatever answers first', async () => {
    await openDuplicates()
    held.set('name-1', () => undefined)
    const slow = searchDuplicates('a', 'name-1')
    await searchDuplicates('a', 'name-11')
    await settle()
    expect(list().items.map(g => g.name)).toEqual([
      'name-11.jpg',
      'name-110.jpg',
      'name-111.jpg',
      'name-112.jpg',
      'name-113.jpg',
      'name-114.jpg',
      'name-115.jpg',
      'name-116.jpg',
      'name-117.jpg',
      'name-118.jpg',
      'name-119.jpg',
    ])
    release('name-1')
    await slow
    await settle()
    expect(list().items[0].name).toBe('name-11.jpg')
    expect(list().query).toBe('name-11')
  })

  it('drops the lists of a project that is no longer selected', async () => {
    await openDuplicates()
    expect(app.duplicates['a']).toBeDefined()
    select('bb')
    await settle()
    expect(app.duplicates['a']).toBeUndefined()
  })
})

describe('the projects table', () => {
  it('moves the selection to what the filters leave', async () => {
    select('bb')
    app.query = 'alf'
    await settle()
    expect(visible.value.map(p => p.id)).toEqual(['a'])
    expect(app.selectedId).toBe('a')
    app.query = 'nessuno'
    await settle()
    expect(app.selectedId).toBeUndefined()
  })

  it('moves along the rows without going past the ends', () => {
    select('a')
    moveSelection(1)
    expect(app.selectedId).toBe('bb')
    moveSelection(Infinity)
    expect(app.selectedId).toBe('ccc')
    moveSelection(5)
    expect(app.selectedId).toBe('ccc')
    moveSelection(-Infinity)
    expect(app.selectedId).toBe('a')
  })
})

describe('the toasts', () => {
  it('say the same thing once and keep the last three', () => {
    notify('Disco pieno')
    notify('Disco pieno')
    expect(app.toasts).toHaveLength(1)
    for (const text of ['uno', 'due', 'tre']) notify(text, 'info')
    expect(app.toasts.map(t => t.text)).toEqual(['uno', 'due', 'tre'])
  })
})
