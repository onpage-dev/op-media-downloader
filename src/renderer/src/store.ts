/**
 * The renderer's state: what main pushes (projects, settings, status, version),
 * what the user picks (selection, filters, search, sort, inspector tab, which
 * dialog is open) and the actions on the selected project. Everything goes
 * through `window.desktop`.
 */
import { computed, reactive, watch } from 'vue'
import type { AppCommand, InspectorTab, NewProjectInput, ProjectPatch, SettingsSection } from '@shared/desktop-api'
import {
  DEFAULT_SETTINGS,
  type ActivityEntry,
  type AppSettings,
  type AppStatus,
  type DestinationKind,
  type DuplicateGroup,
  type FailedEntry,
  type ProjectId,
  type ProjectView,
  type VersionInfo,
} from '@shared/models'
import { matchesFilter, PROJECT_FILTERS, projectStatus, type ProjectFilter, type StatusTone } from '@shared/status'
import { setLanguage } from './i18n'
import { fileCounts, kindOf } from './lib/status-view'

/** `created`, the order in which the projects were added, until a header is clicked */
export type SortKey = 'created' | 'status' | 'label' | 'folder' | 'progress' | 'files' | 'speed' | 'last'
export interface DialogState {
  kind: 'delete' | 'stop' | 'cleanup'
  id: ProjectId
}
export const DESTINATIONS = ['local', 'network', 'removable'] as const

const SPEED_SAMPLES = 40
const ACTIVITY_KEPT = 200

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
  activity: {} as Record<ProjectId, ActivityEntry[]>,
  failed: {} as Record<ProjectId, FailedEntry[]>,
  duplicates: {} as Record<ProjectId, DuplicateGroup[]>,
  /** The last speeds of each running project, for the sparkline */
  speeds: {} as Record<ProjectId, number[]>,
  wizard: undefined as undefined | { folder?: string; step?: number; token?: string },
  dialog: undefined as DialogState | undefined,
  settings_open: undefined as SettingsSection | undefined,
  menu: undefined as undefined | { id: ProjectId; x: number; y: number },
  /** A folder is being dragged over the window */
  dropping: false,
  /** Bumped to move the focus to the search field */
  search_focus: 0,
})

const desktop = (): typeof window.desktop => window.desktop

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
      return project.label.toLocaleLowerCase()
    case 'folder':
      return project.folder.toLocaleLowerCase()
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
  return app.projects
    .filter(
      p =>
        matchesFilter(p, app.filter) &&
        (!app.kind || kindOf(p) == app.kind) &&
        (!query || p.label.toLocaleLowerCase().includes(query) || p.folder.toLocaleLowerCase().includes(query)),
    )
    .sort((a, b) => {
      const [x, y] = [sortValue(a, key), sortValue(b, key)]
      if (x < y) return -dir
      if (x > y) return dir
      return a.label.localeCompare(b.label)
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

/* ------------------------------------------------------------------ Start */

export async function init({ live = true } = {}): Promise<void> {
  const api = desktop()
  const [projects, settings, status, version] = await Promise.all([
    api.projects.list(),
    api.settings.get(),
    api.app.status(),
    api.app.version(),
  ])
  setProjects(projects)
  applySettings(settings)
  app.status = status
  app.version = version
  api.projects.onChanged(setProjects)
  api.settings.onChanged(applySettings)
  api.app.onStatus(next => (app.status = next))
  if (live) {
    api.sync.onActivity(addActivity)
    api.app.onCommand(runCommand)
  }
  app.ready = true
  if (!app.selectedId) select(visible.value[0]?.id)
}

function setProjects(projects: ProjectView[]): void {
  app.projects = projects
  for (const project of projects) {
    if (project.runtime.phase != 'downloading' || !project.runtime.progress) continue
    const samples = (app.speeds[project.id] ??= [])
    samples.push(project.runtime.progress.speed_bps)
    if (samples.length > SPEED_SAMPLES) samples.splice(0, samples.length - SPEED_SAMPLES)
  }
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

/* ------------------------------------------------------------------ Selection and tabs */

export function select(id: ProjectId | undefined): void {
  if (app.selectedId == id) return
  app.selectedId = id
  desktop().app.setSelection(id)
}

/** Moves the selection up or down the visible rows */
export function moveSelection(step: 1 | -1): void {
  const rows = visible.value
  if (!rows.length) return
  const at = rows.findIndex(p => p.id == app.selectedId)
  const next = at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + step))
  select(rows[next].id)
}

// A selection that the filters hide moves to the first row left
watch(visible, rows => {
  if (!app.ready) return
  if (!rows.some(p => p.id == app.selectedId)) select(rows[0]?.id)
})

async function loadTab(id: ProjectId, tab: InspectorTab): Promise<void> {
  try {
    if (tab == 'activity') app.activity[id] = (await desktop().sync.getActivity(id, ACTIVITY_KEPT)).sort((a, b) => b.id - a.id)
    if (tab == 'failed') app.failed[id] = await desktop().sync.getFailed(id)
    if (tab == 'duplicates') app.duplicates[id] = await desktop().sync.getDuplicates(id)
  } catch (error) {
    console.error(`Cannot load ${tab} of ${id}`, error)
  }
}
watch(
  () => [app.selectedId, app.tab, selected.value?.runtime.last_result?.ended_at, selected.value?.runtime.plan?.created_at] as const,
  ([id, tab]) => {
    if (id) void loadTab(id, tab)
  },
)

/* ------------------------------------------------------------------ Actions */

const run = (what: string, action: () => Promise<unknown>): void => {
  action().catch(error => console.error(what, error))
}
const target = (id?: ProjectId): ProjectView | undefined => app.projects.find(p => p.id == (id ?? app.selectedId))

export function sync(id?: ProjectId): void {
  const project = target(id)
  if (project && project.runtime.phase == 'idle') run('sync', () => desktop().sync.sync(project.id))
}
export function download(id?: ProjectId): void {
  const project = target(id)
  if (project && project.runtime.phase == 'idle') run('download', () => desktop().sync.download(project.id))
}
export const syncAll = (): void => run('sync all', () => desktop().sync.syncAll())
export function retryFailed(id?: ProjectId): void {
  const project = target(id)
  if (project) run('retry failed', () => desktop().sync.retryFailed(project.id))
}
export function openFolder(id?: ProjectId): void {
  const project = target(id)
  if (project) run('open folder', () => desktop().folders.open(project.folder))
}
export function copyPath(id?: ProjectId): void {
  const project = target(id)
  if (project) run('copy path', () => desktop().app.copyText(project.folder))
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
  if (dialog.kind == 'stop') run('stop', () => desktop().sync.stop(dialog.id))
  if (dialog.kind == 'cleanup') run('cleanup', () => desktop().sync.confirmCleanup(dialog.id))
  if (dialog.kind == 'delete') {
    run('delete', () => desktop().projects.remove(dialog.id, { delete_files: !!options.delete_files }))
  }
}
export const openWizard = (folder?: string): void => {
  app.wizard = { folder }
}
export async function createProject(input: NewProjectInput): Promise<void> {
  const project = await desktop().projects.create(input)
  app.wizard = undefined
  app.filter = 'all'
  app.kind = undefined
  app.query = ''
  select(project.id)
  app.tab = 'general'
}
export const updateProject = (id: ProjectId, patch: ProjectPatch): Promise<ProjectView> => desktop().projects.update(id, patch)
export const openSettings = (section: SettingsSection = 'general'): void => {
  app.settings_open = section
}
export async function setSettings(patch: Partial<AppSettings>): Promise<void> {
  applySettings(await desktop().settings.set(patch))
}
export function openRelease(): void {
  const url = app.version?.release_url
  if (url) run('open release', () => desktop().app.openExternal(url))
}

/** The commands from the menu of macOS, the notification area and the jump list, and the app's shortcuts */
export function runCommand(command: AppCommand): void {
  switch (command.type) {
    case 'new_project':
      return openWizard(command.folder)
    case 'select_project':
      app.filter = 'all'
      app.kind = undefined
      app.query = ''
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
