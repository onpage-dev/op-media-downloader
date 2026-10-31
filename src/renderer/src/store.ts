/**
 * The renderer's state: what main pushes (projects, settings, status, version),
 * what the user picks (selection, filters, search, sort, inspector tab, which
 * dialog is open), the toasts, and the actions. Every call to main goes through
 * here: a command that fails says why in a toast (and in main's log); what a
 * form asks (create, save, verify, pick, inspect) rejects, and the form says
 * why in place.
 */
import { computed, markRaw, reactive, watch } from 'vue'
import type {
  AppCommand,
  DesktopApi,
  InspectorTab,
  NewProjectInput,
  ProjectPatch,
  SettingsSection,
} from '@shared/desktop-api'
import {
  DEFAULT_SETTINGS,
  type ActivityEntry,
  type AppSettings,
  type AppStatus,
  type DestinationKind,
  type DuplicateGroup,
  type FailedEntry,
  type FolderInfo,
  type ProjectId,
  type ProjectView,
  type TokenCheck,
  type VersionInfo,
} from '@shared/models'
import { matchesFilter, PROJECT_FILTERS, projectStatus, type ProjectFilter, type StatusTone } from '@shared/status'
import { setLanguage } from './i18n'
import { errorText, logError } from './lib/errors'
import { compareText } from './lib/format'
import { fileCounts, kindOf } from './lib/status-view'

/** `created`, the order in which the projects were added, until a header is clicked */
export type SortKey = 'created' | 'status' | 'label' | 'folder' | 'progress' | 'files' | 'speed' | 'last'
export interface DialogState {
  /** `take_over`: use the folder of another On Page project for this one */
  kind: 'delete' | 'stop' | 'cleanup' | 'take_over'
  id: ProjectId
}
export const DESTINATIONS = ['local', 'network', 'removable'] as const

/**
 * A long list (tens of thousands of failed files or duplicate names) shown a
 * page at a time: the next page comes when the end of the list is in view.
 * The entries are raw objects: no reactive proxy for each of them.
 */
export interface PagedList<T> {
  items: T[]
  total: number
  loading: boolean
  error: boolean
  query: string
  /** Bumped by every new search or reload: the answers of an older one are dropped */
  version: number
  /** Duplicates only: names that are one field in different languages */
  language_variants?: number
}
export type PagedKind = 'failed' | 'duplicates'
const PAGE_SIZE = 50

/** The speed of the last minute, for the sparkline: a sample every 1.5 s while a project downloads */
const SPEED_SAMPLES = 40
const SPEED_EVERY_MS = 1500
const ACTIVITY_KEPT = 200

export type ToastTone = 'danger' | 'warning' | 'info' | 'success'
export interface Toast {
  id: number
  tone: ToastTone
  text: string
}
const TOASTS_SHOWN = 3

export const app = reactive({
  ready: false,
  projects: [] as ProjectView[],
  settings: { ...DEFAULT_SETTINGS } as AppSettings,
  status: undefined as AppStatus | undefined,
  version: undefined as VersionInfo | undefined,
  selectedId: undefined as ProjectId | undefined,
  filter: 'all' as ProjectFilter,
  kind: undefined as DestinationKind | undefined,
  query: '',
  sort: { key: 'created' as SortKey, dir: 1 as 1 | -1 },
  tab: 'general' as InspectorTab,
  /** The lists of the selected project (another selection drops them) */
  activity: {} as Record<ProjectId, ActivityEntry[]>,
  failed: {} as Record<ProjectId, PagedList<FailedEntry>>,
  duplicates: {} as Record<ProjectId, PagedList<DuplicateGroup>>,
  /** The last speeds of each downloading project, for the sparkline */
  speeds: {} as Record<ProjectId, number[]>,
  wizard: undefined as undefined | { folder?: string; step?: number; token?: string },
  dialog: undefined as DialogState | undefined,
  settings_open: undefined as SettingsSection | undefined,
  menu: undefined as undefined | { id: ProjectId; x: number; y: number },
  /** A folder is being dragged over the window */
  dropping: false,
  /** Bumped to move the focus to the search field */
  search_focus: 0,
  /** What failed (or happened), newest last */
  toasts: [] as Toast[],
})

const desktop = (): DesktopApi => window.desktop
/** The system the app runs on: some words, shortcuts and settings depend on it */
export const platform = (): DesktopApi['platform'] => desktop().platform

/* ------------------------------------------------------------------ Derived */

export const selected = computed(() => app.projects.find(p => p.id == app.selectedId))

export const counts = computed(() => {
  const result = {} as Record<ProjectFilter | (typeof DESTINATIONS)[number], number>
  for (const filter of PROJECT_FILTERS) result[filter] = app.projects.filter(p => matchesFilter(p, filter)).length
  for (const kind of DESTINATIONS) result[kind] = app.projects.filter(p => kindOf(p) == kind).length
  return result
})

const SEVERITY: Record<StatusTone, number> = { danger: 0, warning: 1, accent: 2, info: 3, neutral: 4, success: 5 }

function sortValue(project: ProjectView, key: SortKey): number | string {
  const status = projectStatus(project)
  switch (key) {
    case 'created':
      return project.created_at
    case 'status':
      return SEVERITY[status.tone]
    case 'label':
      return project.label
    case 'folder':
      return project.folder
    case 'progress':
      return status.progress ?? (status.count ? 0 : -1)
    case 'files':
      return fileCounts(project)?.[1] ?? -1
    case 'speed':
      return project.runtime.progress?.speed_bps ?? 0
    case 'last':
      return project.runtime.last_result?.ended_at ?? ''
  }
}

export const visible = computed(() => {
  const query = app.query.trim().toLocaleLowerCase()
  const { key, dir } = app.sort
  // Names and folders in the language's order; dates (ISO) and numbers as they are
  const words = key == 'label' || key == 'folder'
  return app.projects
    .filter(
      p =>
        matchesFilter(p, app.filter) &&
        (!app.kind || kindOf(p) == app.kind) &&
        (!query || p.label.toLocaleLowerCase().includes(query) || p.folder.toLocaleLowerCase().includes(query)),
    )
    .sort((a, b) => {
      const [x, y] = [sortValue(a, key), sortValue(b, key)]
      const order = words ? compareText(String(x), String(y)) : x < y ? -1 : x > y ? 1 : 0
      return order * dir || compareText(a.label, b.label)
    })
})

/** What the toolbar, the menus and the shortcuts can do on the selected project */
export const can = computed(() => {
  const project = selected.value
  const phase = project?.runtime.phase
  const busy = !!project && phase != 'idle'
  return {
    sync: !!project && !busy,
    download: !!project && !busy && (project.runtime.plan?.to_download_names ?? 0) > 0,
    stop: busy && phase != 'stopping',
    sync_all: app.projects.some(p => p.runtime.phase == 'idle'),
    selected: !!project,
  }
})

/* ------------------------------------------------------------------ Toasts */

let toastIds = 0
/** A toast; the same words again replace the older one, and three at most stay */
export function notify(text: string, tone: ToastTone = 'danger'): void {
  const toasts = app.toasts.filter(toast => toast.text != text)
  toasts.push({ id: ++toastIds, tone, text })
  app.toasts = toasts.slice(-TOASTS_SHOWN)
}
export function dismiss(id: number): void {
  app.toasts = app.toasts.filter(toast => toast.id != id)
}

/** A call to main that failed: in main's log, and in words in a toast */
function fail(what: string, error: unknown): void {
  logError(what, error, 'warn')
  notify(errorText(error))
}
async function run(what: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch (error) {
    fail(what, error)
  }
}

/* ------------------------------------------------------------------ Start */

/** The panel of the notification area and the settings alone take no activity, no commands, no speeds */
let live = false

export async function init(options: { live?: boolean } = {}): Promise<void> {
  live = options.live ?? true
  const api = desktop()
  // Listening first: what main pushes while the first answers travel is newer than them
  const pushed = new Set<string>()
  function first<T>(key: string, apply: (value: T) => void): (value: T) => void {
    return value => {
      pushed.add(key)
      apply(value)
    }
  }
  api.projects.onChanged(first('projects', setProjects))
  api.settings.onChanged(first('settings', applySettings))
  api.app.onStatus(first('status', (next: AppStatus) => (app.status = next)))
  // The result of every check for updates, the one at start-up too
  api.app.onVersion(first('version', (next: VersionInfo) => (app.version = next)))
  if (live) {
    api.sync.onActivity(addActivity)
    api.app.onCommand(runCommand)
  }
  try {
    const [projects, settings, status, version] = await Promise.all([
      api.projects.list(),
      api.settings.get(),
      api.app.status(),
      api.app.version(),
    ])
    if (!pushed.has('projects')) setProjects(projects)
    if (!pushed.has('settings')) applySettings(settings)
    if (!pushed.has('status')) app.status = status
    if (!pushed.has('version')) app.version = version
  } catch (error) {
    return fail('start', error)
  }
  app.ready = true
  if (!app.selectedId) select(visible.value[0]?.id)
}

function setProjects(projects: ProjectView[]): void {
  app.projects = projects
  // A deleted project leaves nothing behind
  const kept = new Set(projects.map(p => p.id))
  for (const lists of [app.activity, app.failed, app.duplicates, app.speeds]) {
    for (const id of Object.keys(lists)) if (!kept.has(id)) delete lists[id]
  }
  trackSpeeds()
}

/** The view main answers with, before it pushes the whole list (100 ms later) */
function mergeProject(view: ProjectView): void {
  const known = app.projects.some(p => p.id == view.id)
  app.projects = known ? app.projects.map(p => (p.id == view.id ? view : p)) : [...app.projects, view]
}

function applySettings(settings: AppSettings): void {
  app.settings = settings
  setLanguage(settings.language)
  // main sets nativeTheme from the setting; the attribute only matters where nothing else does (the browser)
  if (settings.theme == 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = settings.theme
}

function addActivity(id: ProjectId, entries: ActivityEntry[]): void {
  const known = app.activity[id]
  if (!known) return
  const byId = new Map(known.map(entry => [entry.id, entry]))
  for (const entry of entries) byId.set(entry.id, entry)
  app.activity[id] = [...byId.values()].sort((a, b) => b.id - a.id).slice(0, ACTIVITY_KEPT)
}

/* ------------------------------------------------------------------ Speeds */

/** The run each project's samples belong to: another run starts the line again */
const runs = new Map<ProjectId, string>()
let sampler: ReturnType<typeof setInterval> | undefined

function trackSpeeds(): void {
  let downloading = false
  for (const project of app.projects) {
    const progress = project.runtime.phase == 'downloading' ? project.runtime.progress : undefined
    if (!progress) {
      runs.delete(project.id)
      delete app.speeds[project.id]
      continue
    }
    downloading = true
    if (runs.get(project.id) != progress.started_at) {
      runs.set(project.id, progress.started_at)
      app.speeds[project.id] = [progress.speed_bps]
    }
  }
  for (const id of runs.keys()) if (!(id in app.speeds)) runs.delete(id)
  if (downloading && live) sampler ??= setInterval(sampleSpeeds, SPEED_EVERY_MS)
  else if (sampler) {
    clearInterval(sampler)
    sampler = undefined
  }
}

/** A sample per unit of time, not per push: the line is as long as the last minute */
function sampleSpeeds(): void {
  for (const project of app.projects) {
    const samples = app.speeds[project.id]
    const speed = project.runtime.progress?.speed_bps
    if (!samples || speed == null) continue
    samples.push(speed)
    if (samples.length > SPEED_SAMPLES) samples.splice(0, samples.length - SPEED_SAMPLES)
  }
}

/* ------------------------------------------------------------------ Selection and tabs */

export function select(id: ProjectId | undefined): void {
  app.selectedId = id
}

/** Moves the selection along the visible rows: ±1 for the arrows, more for the pages, ±Infinity for the ends */
export function moveSelection(step: number): void {
  const rows = visible.value
  if (!rows.length) return
  const at = rows.findIndex(p => p.id == app.selectedId)
  const from = at >= 0 ? at : step > 0 ? -1 : rows.length
  select(rows[Math.min(rows.length - 1, Math.max(0, from + step))].id)
}

/** No filter, no destination, no search: every project in the table */
export function showAll(): void {
  app.filter = 'all'
  app.kind = undefined
  app.query = ''
}

// A selection that the filters hide moves to the first row left
watch(visible, rows => {
  if (!app.ready) return
  if (!rows.some(p => p.id == app.selectedId)) select(rows[0]?.id)
})

// The lists of a project live while it is selected: thousands of failed files are not kept for nothing
watch(
  () => app.selectedId,
  id => {
    for (const lists of [app.activity, app.failed, app.duplicates]) {
      for (const key of Object.keys(lists)) if (key != id) delete lists[key]
    }
  },
)

async function loadTab(id: ProjectId, tab: InspectorTab): Promise<void> {
  if (tab == 'activity') {
    try {
      app.activity[id] = (await desktop().sync.getActivity(id, ACTIVITY_KEPT)).sort((a, b) => b.id - a.id)
    } catch (error) {
      fail('load activity', error)
    }
  }
  if (tab == 'failed' || tab == 'duplicates') await loadPage(tab, id, true)
}

function pagedList<T>(lists: Record<ProjectId, PagedList<T>>, id: ProjectId): PagedList<T> {
  if (!lists[id]) lists[id] = { items: [], total: 0, loading: false, error: false, query: '', version: 0 }
  // Read back through the reactive record: changes made on the object assigned above would not be seen
  return lists[id]
}

/** The first page again (`reset`: a new search, a reload), or the next one; a failure shows in the list, with «Riprova» */
async function loadPage(kind: PagedKind, id: ProjectId, reset: boolean): Promise<void> {
  const list: PagedList<FailedEntry | DuplicateGroup> = pagedList<FailedEntry | DuplicateGroup>(app[kind], id)
  if (!reset && (list.loading || list.error || list.items.length >= list.total)) return
  const version = reset ? ++list.version : list.version
  list.loading = true
  list.error = false
  try {
    const query = { offset: reset ? 0 : list.items.length, limit: PAGE_SIZE, query: list.query || undefined }
    const page =
      kind == 'failed' ? await desktop().sync.getFailed(id, query) : await desktop().sync.getDuplicates(id, query)
    if (version != list.version) return
    const items = 'groups' in page ? page.groups : page.entries
    list.items = markRaw(reset ? items : [...list.items, ...items])
    list.total = page.total
    if ('language_variants' in page) list.language_variants = page.language_variants
  } catch (error) {
    logError(`load ${kind}`, error, 'warn')
    if (version == list.version) list.error = true
  } finally {
    if (version == list.version) list.loading = false
  }
}

export const loadMore = (kind: PagedKind, id: ProjectId): Promise<void> => loadPage(kind, id, false)
export const reloadList = (kind: PagedKind, id: ProjectId): Promise<void> => loadPage(kind, id, true)

export function searchDuplicates(id: ProjectId, query: string): Promise<void> {
  pagedList(app.duplicates, id).query = query
  return loadPage('duplicates', id, true)
}
// One source per value: a getter returning a new array would fire on every state pushed by
// main (several a second during a sync) and reload the whole tab each time
watch(
  [
    () => app.selectedId,
    () => app.tab,
    () => selected.value?.runtime.last_result?.ended_at,
    () => selected.value?.runtime.plan?.created_at,
  ],
  ([id, tab]) => {
    if (id) void loadTab(id, tab)
  },
)

/* ------------------------------------------------------------------ Commands */

const target = (id?: ProjectId): ProjectView | undefined => app.projects.find(p => p.id == (id ?? app.selectedId))

export function sync(id?: ProjectId): void {
  const project = target(id)
  if (project && project.runtime.phase == 'idle') void run('sync', () => desktop().sync.sync(project.id))
}
export function download(id?: ProjectId): void {
  const project = target(id)
  if (project && project.runtime.phase == 'idle') void run('download', () => desktop().sync.download(project.id))
}
export const syncAll = (): void => void run('sync all', () => desktop().sync.syncAll())
export function retryFailed(id?: ProjectId): void {
  const project = target(id)
  if (project) void run('retry failed', () => desktop().sync.retryFailed(project.id))
}
export function openFolder(id?: ProjectId): void {
  const project = target(id)
  if (project) void run('open folder', () => desktop().folders.openProject(project.id))
}
export function copyPath(id?: ProjectId): void {
  const project = target(id)
  if (project) void run('copy path', () => desktop().app.copyText(project.folder))
}
export function edit(id?: ProjectId): void {
  const project = target(id)
  if (!project) return
  select(project.id)
  app.tab = 'settings'
}
export function ask(kind: DialogState['kind'], id?: ProjectId): void {
  const project = target(id)
  if (project) app.dialog = { kind, id: project.id }
}
export function confirmDialog(options: { delete_files?: boolean } = {}): void {
  const dialog = app.dialog
  app.dialog = undefined
  if (!dialog) return
  if (dialog.kind == 'stop') void run('stop', () => desktop().sync.stop(dialog.id))
  if (dialog.kind == 'cleanup') void run('cleanup', () => desktop().sync.confirmCleanup(dialog.id))
  if (dialog.kind == 'take_over') {
    void run('take over folder', () => desktop().sync.sync(dialog.id, { take_over_folder: true }))
  }
  if (dialog.kind == 'delete') {
    void run('delete', () => desktop().projects.remove(dialog.id, { delete_files: !!options.delete_files }))
  }
}
export const openWizard = (folder?: string): void => {
  app.wizard = { folder }
}
/** A folder dropped on the window: the new project with it */
export function openDroppedFolder(file: File): void {
  try {
    openWizard(desktop().folders.pathForDroppedFile(file))
  } catch (error) {
    fail('dropped folder', error)
  }
}
export const openSettings = (section: SettingsSection = 'general'): void => {
  app.settings_open = section
}
export const closeSettings = (): void => {
  app.settings_open = undefined
}
export async function setSettings(patch: Partial<AppSettings>): Promise<void> {
  await run('settings', async () => applySettings(await desktop().settings.set(patch)))
}
export async function checkForUpdates(): Promise<void> {
  await run('check for updates', async () => {
    app.version = await desktop().app.checkForUpdates()
  })
}
export function openRelease(): void {
  const url = app.version?.release_url
  if (url) void run('open release', () => desktop().app.openExternal(url))
}
/** A thing on On Page, in the browser */
export const openOnPage = (url: string): void => void run('open link', () => desktop().app.openExternal(url))
export const openLicenses = (): void => void run('open licenses', () => desktop().app.openLicenses())
export const showMainWindow = (command?: AppCommand): void => desktop().app.showMainWindow(command)
export const quit = (): void => desktop().app.quit()
export const closeWindow = (): void => desktop().app.window.close()

/* ------------------------------------------------------------------ What a form asks */

/** The new project, already in the list and selected (main pushes the list a moment later) */
export async function createProject(input: NewProjectInput): Promise<ProjectView> {
  const project = await desktop().projects.create(input)
  mergeProject(project)
  app.wizard = undefined
  showAll()
  select(project.id)
  app.tab = 'general'
  return project
}
/** The project as saved: the form starts again from it, not from the old one */
export async function updateProject(id: ProjectId, patch: ProjectPatch): Promise<ProjectView> {
  const project = await desktop().projects.update(id, patch)
  mergeProject(project)
  return project
}
export const verifyToken = (token: string): Promise<TokenCheck> => desktop().tokens.verify(token)
/** The saved token, checked in main without reaching the page */
export const verifyProjectToken = (id: ProjectId): Promise<TokenCheck> => desktop().tokens.verifyProject(id)
export const revealToken = (id: ProjectId): Promise<string> => desktop().projects.revealToken(id)
export const pickFolder = (from?: string): Promise<string | undefined> => desktop().folders.pick(from)
export const inspectFolder = (path: string, id?: ProjectId): Promise<FolderInfo> => desktop().folders.inspect(path, id)

/** The commands from the menu of macOS, the notification area and the jump list, and the app's shortcuts */
export function runCommand(command: AppCommand): void {
  switch (command.type) {
    case 'new_project':
      return openWizard(command.folder)
    case 'select_project':
      showAll()
      select(command.project_id)
      if (command.tab) app.tab = command.tab
      return
    case 'sync_selected':
      return sync()
    case 'sync_all':
      return syncAll()
    case 'download_selected':
      return download()
    case 'stop_selected':
      return can.value.stop ? ask('stop') : undefined
    case 'open_folder_selected':
      return openFolder()
    case 'edit_selected':
      return edit()
    case 'delete_selected':
      return ask('delete')
    case 'open_settings':
      return openSettings(command.section)
    case 'focus_search':
      app.search_focus++
      return
  }
}
