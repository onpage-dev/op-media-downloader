/**
 * A stand-in for `window.desktop` with the six projects of the mockup B, so the
 * renderer runs alone in a browser (dev server, captures). It is installed only
 * when the preload did not expose the real API: never inside Electron.
 * URL parameters: `empty` (no projects), `duplicates` (Catalogo Piante 2026 with
 * names with different files; `duplicates=many`: 3,000 of them), `freeze` (no live progress), `fail=<code>` (the
 * commands reject with that code, as main does: `project_busy`, `engine_timeout`…),
 * `taken` (another computer synced the folder of Schede tecniche with another On
 * Page project). A folder with «Listino 2026» in its path is that other
 * project's, and so is a token with «listino» in it.
 * Like main, it answers a change with the project and pushes the list 100 ms later.
 */
import type { AppCommand, DesktopApi, NewProjectInput, ProjectPatch } from '@shared/desktop-api'
import {
  DEFAULT_SETTINGS,
  type ActivityEntry,
  type AppSettings,
  type AppStatus,
  type DestinationKind,
  type DuplicateGroup,
  type DuplicateUse,
  type FailedEntry,
  type FolderInfo,
  type Issue,
  type OnPageProject,
  type PlanSummary,
  type ProjectRuntime,
  type ProjectView,
  type SyncResult,
  type VersionInfo,
} from '@shared/models'

const params = new URLSearchParams(location.search)
const MB = 1024 ** 2
const GB = 1024 ** 3
const TB = 1024 ** 4

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60000).toISOString()
const day = (month: number, date: number, hours: number, minutes: number): string =>
  new Date(new Date().getFullYear(), month - 1, date, hours, minutes).toISOString()
const yesterday = (hours: number, minutes: number): string => {
  const d = new Date(Date.now() - 86400000)
  d.setHours(hours, minutes, 0, 0)
  return d.toISOString()
}

function plan(
  remote_names: number,
  remote_bytes: number,
  to_download_names = 0,
  more: Partial<PlanSummary> = {},
): PlanSummary {
  return {
    created_at: minutesAgo(3),
    remote_names,
    remote_bytes,
    to_download: to_download_names,
    to_download_names,
    to_download_bytes: Math.round((remote_bytes * to_download_names) / Math.max(1, remote_names)),
    to_link: 0,
    to_remove: 0,
    up_to_date: remote_names - to_download_names,
    duplicates: 0,
    conflicts: 0,
    cleanup_needs_confirmation: false,
    listing: 'incremental',
    ...more,
  }
}

function result(ended_at: string, total: number, minutes: number, more: Partial<SyncResult> = {}): SyncResult {
  return {
    job: 'download',
    started_at: new Date(new Date(ended_at).getTime() - minutes * 60000).toISOString(),
    ended_at,
    outcome: 'completed',
    total,
    downloaded: 0,
    linked: 0,
    removed: 0,
    already_present: total,
    failed: 0,
    bytes: 0,
    ...more,
  }
}

function folder(path: string, kind: DestinationKind, more: Partial<FolderInfo> = {}): FolderInfo {
  return {
    path,
    kind,
    exists: true,
    writable: true,
    free_bytes: 418 * GB,
    hardlinks: true,
    foreign_entries: 0,
    problems: [],
    inspected_at: minutesAgo(1),
    ...more,
  }
}

const issue = (code: Issue['code'], severity: Issue['severity'], count?: number): Issue => ({
  code,
  severity,
  count,
  at: minutesAgo(2),
})
const idle = (more: Partial<ProjectRuntime> = {}): ProjectRuntime => ({ phase: 'idle', issues: [], ...more })

/** The On Page project of each demo project; Listino Acme never synced (its token is not valid) */
const ONPAGE: Record<string, OnPageProject> = {
  vasi: { id: 101, label: 'Vasi e accessori' },
  eventi: { id: 102, label: 'Foto eventi' },
  archivio: { id: 103, label: 'Archivio foto' },
  piante: { id: 104, label: 'Catalogo Piante 2026' },
  schede: { id: 105, label: 'Schede tecniche' },
}
/** Another On Page project, synced by another computer */
const LISTINO: OnPageProject = { id: 120, label: 'Listino 2026' }
const taken = params.has('taken')
/** `cleanup`: Catalogo Piante 2026 waits for the confirmation of a large removal */
const cleanup = params.has('cleanup')

let created = 0
function project(
  id: string,
  label: string,
  path: string,
  info: FolderInfo,
  runtime: ProjectRuntime,
  keep_old_files = false,
): ProjectView {
  // Added a day apart, in the order of the mockup
  const created_at = new Date(new Date(2026, 8, 2).getTime() + created++ * 86400000).toISOString()
  const onpage_project = ONPAGE[id] as OnPageProject | undefined
  return {
    id,
    label,
    folder: path,
    keep_old_files,
    created_at,
    has_token: true,
    folder_info: { onpage_project, ...info },
    runtime,
    onpage_project,
  }
}

const VASI = '\\\\nas-ufficio\\media\\vasi'
const EVENTI = '\\\\nas-eventi\\foto'

let projects: ProjectView[] = params.has('empty')
  ? []
  : [
      project(
        'vasi',
        'Vasi e accessori',
        VASI,
        folder(VASI, 'network', { free_bytes: 1.2 * TB, hardlinks: false, foreign_entries: 214 }),
        {
          phase: 'downloading',
          job: 'download',
          progress: {
            started_at: minutesAgo(12),
            total: 12840,
            downloaded: 3214,
            linked: 0,
            removed: 0,
            already_present: 0,
            failed: 3,
            bytes_done: 2.4 * GB,
            bytes_total: 9.6 * GB,
            speed_bps: 4.2 * MB,
            eta_seconds: 362,
            in_flight: 4,
            concurrency: 4,
          },
          plan: plan(12840, 9.6 * GB, 12840),
          issues: [issue('copies_instead_of_links', 'warning')],
        },
        true,
      ),
      project('eventi', 'Foto eventi', EVENTI, folder(EVENTI, 'network', { free_bytes: 3.1 * TB, hardlinks: true }), {
        phase: 'comparing',
        job: 'sync',
        progress: {
          started_at: minutesAgo(1),
          listing: { resources_done: 2, resources_total: 2, things_read: 35156 },
          total: 0,
          downloaded: 0,
          linked: 0,
          removed: 0,
          already_present: 0,
          failed: 0,
          bytes_done: 0,
          bytes_total: 0,
          speed_bps: 0,
          in_flight: 0,
          concurrency: 4,
        },
        last_result: result(day(10, 28, 18, 9), 35156, 7),
        issues: [],
      }),
      project(
        'archivio',
        'Archivio foto',
        'E:\\Archivio foto',
        folder('E:\\Archivio foto', 'removable', { free_bytes: 418 * GB, foreign_entries: 27 }),
        idle({ plan: plan(6470, 4.0 * GB, 128), last_result: result(day(10, 28, 18, 9), 6342, 7) }),
      ),
      project(
        'piante',
        'Catalogo Piante 2026',
        'D:\\Media\\Catalogo piante',
        folder('D:\\Media\\Catalogo piante', 'local', { free_bytes: 612 * GB }),
        idle({
          plan: plan(48225, 31.8 * GB, 0, {
            ...(params.has('duplicates') ? { duplicates: 3 } : {}),
            ...(cleanup ? { to_remove: 184 } : {}),
          }),
          last_result: result(minutesAgo(5), 48225, 4, { downloaded: 128, already_present: 48097, bytes: 82 * MB }),
          issues: [
            ...(params.has('duplicates') ? [issue('duplicates', 'warning', 3)] : []),
            ...(cleanup ? [issue('cleanup_needs_confirmation', 'warning', 184)] : []),
          ],
        }),
      ),
      project(
        'schede',
        'Schede tecniche',
        'C:\\Media\\Schede tecniche',
        folder('C:\\Media\\Schede tecniche', 'local', {
          free_bytes: 212 * GB,
          ...(taken ? { onpage_project: LISTINO } : {}),
        }),
        idle({
          plan: plan(1630, 1.9 * GB),
          last_result: result(yesterday(18, 9), 1630, 2),
          issues: taken ? [{ ...issue('folder_other_project', 'error'), detail: LISTINO.label }] : [],
        }),
      ),
      project(
        'acme',
        'Listino Acme',
        'C:\\Users\\Public\\Listino Acme',
        folder('C:\\Users\\Public\\Listino Acme', 'local', { free_bytes: 212 * GB }),
        idle({ issues: [issue('token_invalid', 'error')] }),
      ),
    ]

let settings: AppSettings = { ...DEFAULT_SETTINGS }
const status = (): AppStatus => {
  const running = projects.filter(p => p.runtime.phase != 'idle')
  return {
    online: true,
    running_jobs: running.length,
    speed_bps: running.reduce((sum, p) => sum + (p.runtime.progress?.speed_bps ?? 0), 0),
    total_files: projects.length ? 94567 : 0,
    total_bytes: projects.length ? 61.2 * GB : 0,
  }
}
const version: VersionInfo = {
  current: '2.0.0',
  latest: '2.0.1',
  release_url: 'https://github.com/onpage-dev/op-media-downloader/releases/latest',
  checked_at: minutesAgo(30),
}

let nextActivity = 1
const at = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString()
const entry = (more: Omit<ActivityEntry, 'id' | 'at'>, seconds = 0): ActivityEntry => ({
  id: nextActivity++,
  at: at(seconds),
  ...more,
})
const activity: Record<string, ActivityEntry[]> = {
  vasi: [
    entry({ name: 'listino-vasi-2025.pdf', outcome: 'removed' }, 6),
    entry({ name: 'cassetta-legno-60.jpg', size: 930 * 1024, outcome: 'downloaded' }, 5),
    entry({ name: 'vaso-smaltato-verde.png', outcome: 'failed', reason: 'not_found' }, 4),
    entry(
      { name: 'vaso-terracotta-24-retro.jpg', size: 1.1 * MB, outcome: 'linked', same_as: 'vaso-terracotta-24.jpg' },
      3,
    ),
    entry({ name: 'vaso-terracotta-24.jpg', size: 1.1 * MB, outcome: 'downloaded' }, 3),
    entry({ name: 'vaso-smaltato-blu-18.jpg', size: 1.2 * MB, outcome: 'downloading', progress: 0.22 }, 1),
    entry({ name: 'sottovaso-30-terracotta.jpg', size: 845 * 1024, outcome: 'downloading', progress: 0.6 }, 1),
  ],
}
const failed: Record<string, FailedEntry[]> = {
  vasi: [
    { name: 'vaso-smaltato-verde.png', token: 't1', reason: 'not_found', detail: '404', attempts: 1, at: at(40) },
    {
      name: 'sottovaso-tondo-40.jpg',
      token: 't2',
      size: 2.1 * MB,
      reason: 'network',
      detail: 'ECONNRESET',
      attempts: 4,
      at: at(30),
    },
    { name: 'scheda «vaso:alto».pdf', token: 't3', size: 310 * 1024, reason: 'invalid_name', attempts: 1, at: at(20) },
  ],
}
const use = (
  resource_label: string,
  field_label: string,
  thing_label: string,
  thing_id: number,
  lang?: string,
): DuplicateUse => ({
  resource_label,
  field_label,
  thing_label,
  thing_id,
  lang,
  edit_url: `https://app.onpage.it/#/things/edit/${thing_id}`,
})
const duplicates: Record<string, DuplicateGroup[]> = {
  piante: [
    {
      name: 'aloe-vera.jpg',
      variants: [
        {
          token: 'd1',
          size: 865234,
          width: 1200,
          height: 1200,
          chosen: true,
          uses: [
            use('Prodotti', 'Foto principale', 'Aloe vera 20 cm', 120034),
            use('Varianti', 'Immagine', 'Aloe vera vaso 14 cm', 120211),
          ],
        },
        {
          token: 'd2',
          size: 319488,
          width: 800,
          height: 800,
          chosen: false,
          uses: [
            use('Prodotti', 'Galleria', 'Aloe vera XL', 120090, 'it'),
            use('Prodotti', 'Galleria', 'Aloe vera XL', 120090, 'en'),
          ],
        },
      ],
    },
    {
      name: 'begonia.jpg',
      variants: [
        {
          token: 'd3',
          size: 1258291,
          width: 1600,
          height: 1067,
          chosen: true,
          uses: [use('Prodotti', 'Foto principale', 'Begonia maculata', 120120)],
        },
        {
          token: 'd4',
          size: 1003520,
          width: 1600,
          height: 1067,
          chosen: false,
          uses: [use('Prodotti', 'Foto principale', 'Begonia ferox', 120121)],
        },
      ],
    },
    {
      name: 'monstera.jpg',
      variants: [
        {
          token: 'd5',
          size: 2516582,
          width: 2000,
          height: 2000,
          chosen: true,
          uses: [use('Prodotti', 'Foto principale', 'Monstera deliciosa', 120300)],
        },
        {
          token: 'd6',
          size: 412672,
          width: 1000,
          height: 1000,
          chosen: false,
          uses: [use('Schede tecniche', 'Allegati', 'Scheda Monstera', 88012, 'it')],
        },
      ],
    },
  ],
}
/** `duplicates=many`: thousands of names, as a big real project has (the tab under load) */
if (params.get('duplicates') == 'many') {
  duplicates.piante = Array.from({ length: 3000 }, (_, g): DuplicateGroup => ({
    name: `pianta-${g + 1}.jpg`,
    variants: Array.from({ length: 2 + (g % 2) }, (_, v) => ({
      token: `many-${g}-${v}`,
      size: 200_000 + g * 37 + v,
      width: 1200,
      height: 900,
      chosen: v == 0,
      uses: Array.from({ length: 4 + ((g + v) % 17) }, (_, u) =>
        use('Prodotti', u % 2 ? 'Galleria' : 'Foto principale', `Pianta ${g + 1}`, 100_000 + g * 20 + u),
      ),
    })),
  }))
}

/* ------------------------------------------------------------------ Events */

type Listener<T extends unknown[]> = (...args: T) => void
function channel<T extends unknown[]>(): { add(listener: Listener<T>): () => void; emit(...args: T): void } {
  const listeners = new Set<Listener<T>>()
  return {
    add(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: (...args) => listeners.forEach(listener => listener(...args)),
  }
}
const projectsChanged = channel<[ProjectView[]]>()
const settingsChanged = channel<[AppSettings]>()
const statusChanged = channel<[AppStatus]>()
const activityAdded = channel<[string, ActivityEntry[]]>()
const commands = channel<[AppCommand]>()
const versionChanged = channel<[VersionInfo]>()

const clone = <T>(value: T): T => structuredClone(value)
/** As main: the list goes 100 ms after the first change, with whatever changed meanwhile */
let pushing: ReturnType<typeof setTimeout> | undefined
const emitProjects = (): void => {
  pushing ??= setTimeout(() => {
    pushing = undefined
    projectsChanged.emit(clone(projects))
    statusChanged.emit(status())
  }, 100)
}
/** `fail=<code>`: the commands reject as main's do */
const failing = params.get('fail')
const command = async <T>(run: () => Promise<T>): Promise<T> => {
  if (failing) throw new Error(failing)
  return run()
}
const later = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const find = (id: string): ProjectView => {
  const found = projects.find(p => p.id == id)
  if (!found) throw new Error(`No project ${id}`)
  return found
}

/** A sync that reads, compares and leaves the plan, in a few seconds */
async function fakeSync(id: string): Promise<void> {
  const p = find(id)
  p.runtime = { ...p.runtime, phase: 'listing', job: 'sync', issues: [] }
  emitProjects()
  await later(1500)
  p.runtime = { ...p.runtime, phase: 'comparing' }
  emitProjects()
  await later(1500)
  const remote = p.runtime.plan?.remote_names ?? 2400
  p.runtime = {
    phase: 'idle',
    issues: [],
    plan: plan(remote, 1.5 * GB, Math.round(remote / 20)),
    last_result: p.runtime.last_result,
  }
  emitProjects()
}

/**
 * What main would find in a folder: a drive root is protected, a folder in or
 * around another project's is used (with that project's label), a name ending
 * in «data» stands for a folder that already has a `data` the app did not make;
 * the project's own folder, or one with «Listino 2026», names its On Page project
 */
function inspect(path: string, projectId?: string): FolderInfo {
  const network = path.startsWith('\\\\')
  const kind = network ? 'network' : path.startsWith('E:') ? 'removable' : 'local'
  const near = (a: string, b: string): boolean => {
    const [x, y] = [a, b].map(p => p.toLowerCase().replace(/\\+$/, '') + '\\')
    return x.startsWith(y) || y.startsWith(x)
  }
  if (/^[A-Z]:\\?$/i.test(path)) return folder(path, kind, { problems: ['protected'] })
  const other = projects.find(p => p.id != projectId && near(p.folder, path))
  if (other) return folder(path, kind, { problems: ['used_by_other_project'], problem_detail: other.label })
  if (/data\\?$/i.test(path)) return folder(path, kind, { problems: ['foreign_data'], foreign_entries: 1 })
  const own = projects.find(p => p.id == projectId && near(p.folder, path))
  const onpage_project = /listino 2026/i.test(path) ? LISTINO : own?.folder_info?.onpage_project
  if (kind == 'removable') return folder(path, kind, { onpage_project })
  return folder(path, kind, {
    onpage_project,
    ...(network ? { hardlinks: false, free_bytes: 1.2 * TB, foreign_entries: 214 } : {}),
  })
}

const desktop: DesktopApi = {
  platform: navigator.userAgent.includes('Mac') ? 'darwin' : 'win32',
  projects: {
    list: async () => clone(projects),
    async create(input: NewProjectInput) {
      const created = project(
        `p${Date.now()}`,
        input.label,
        input.folder,
        inspect(input.folder),
        idle(),
        input.keep_old_files,
      )
      projects = [...projects, created]
      emitProjects()
      if (input.sync_now) void fakeSync(created.id)
      return clone(created)
    },
    async update(id: string, patch: ProjectPatch) {
      const p = find(id)
      if (patch.label != null) p.label = patch.label
      if (patch.folder != null) {
        p.folder = patch.folder
        p.folder_info = inspect(patch.folder, id)
      }
      if (patch.keep_old_files != null) p.keep_old_files = patch.keep_old_files
      if (patch.token) p.runtime.issues = p.runtime.issues.filter(i => i.code != 'token_invalid')
      emitProjects()
      return clone(p)
    },
    async remove(id) {
      projects = projects.filter(p => p.id != id)
      emitProjects()
    },
    revealToken: async id => `demo-0000-${id}-2b81e4`,
    onChanged: listener => projectsChanged.add(listener),
  },
  sync: {
    sync: (id, options) =>
      command(async () => {
        // «Usa questa cartella»: the folder becomes the project's
        const p = find(id)
        if (options?.take_over_folder && p.folder_info)
          p.folder_info = { ...p.folder_info, onpage_project: p.onpage_project }
        void fakeSync(id)
      }),
    syncAll: () =>
      command(async () => {
        for (const p of projects) if (p.runtime.phase == 'idle') void fakeSync(p.id)
      }),
    download: id =>
      command(async () => {
        const p = find(id)
        p.runtime = { ...p.runtime, phase: 'downloading', job: 'download' }
        emitProjects()
      }),
    retryFailed: () => command(async () => undefined),
    async confirmCleanup(id) {
      const p = find(id)
      p.runtime.issues = p.runtime.issues.filter(i => i.code != 'cleanup_needs_confirmation')
      emitProjects()
    },
    async stop(id) {
      const p = find(id)
      p.runtime = { ...p.runtime, phase: 'stopping' }
      emitProjects()
      await later(1200)
      p.runtime = {
        phase: 'idle',
        issues: p.runtime.issues,
        plan: p.runtime.plan,
        last_result: result(new Date().toISOString(), 12840, 12, {
          outcome: 'stopped',
          downloaded: 3214,
          failed: 3,
          already_present: 0,
        }),
      }
      emitProjects()
    },
    getActivity: async id => clone(activity[id] ?? []),
    onActivity: listener => activityAdded.add(listener),
    getFailed: async (id, page) => {
      const all = failed[id] ?? []
      return clone({ total: all.length, entries: all.slice(page.offset, page.offset + page.limit) })
    },
    getDuplicates: async (id, page) => {
      // The rows come from the computer at once; the labels of the things from On Page, slowly
      const labels = page.labels ?? true
      await later(labels ? 1500 : 30)
      const query = page.query?.toLowerCase()
      const all = (duplicates[id] ?? []).filter(g => !query || g.name.toLowerCase().includes(query))
      const groups = clone(all.slice(page.offset, page.offset + page.limit))
      if (!labels) for (const use of groups.flatMap(g => g.variants).flatMap(v => v.uses)) delete use.thing_label
      return { total: all.length, language_variants: 0, groups, labels_pending: !labels && groups.length > 0 }
    },
  },
  folders: {
    pick: async () => 'D:\\Media\\Listino 2027',
    inspect: async (path, projectId) => {
      await later(400)
      return inspect(path, projectId)
    },
    openProject: () => command(async () => undefined),
    // The browser's own drag and drop, with a made-up path for the name of what was dropped
    onDrag: listener => {
      const files = (event: DragEvent): boolean => !!event.dataTransfer?.types.includes('Files')
      const over = (event: DragEvent): void => {
        if (!files(event)) return
        event.preventDefault()
        listener({ type: 'enter' })
      }
      const leave = (event: DragEvent): void => {
        if (!event.relatedTarget) listener({ type: 'leave' })
      }
      const drop = (event: DragEvent): void => {
        if (!files(event)) return
        event.preventDefault()
        const names = Array.from(event.dataTransfer?.files ?? [], file => `D:\\Media\\${file.name}`)
        listener({ type: 'drop', paths: names })
      }
      window.addEventListener('dragover', over)
      window.addEventListener('dragleave', leave)
      window.addEventListener('drop', drop)
      return () => {
        window.removeEventListener('dragover', over)
        window.removeEventListener('dragleave', leave)
        window.removeEventListener('drop', drop)
      }
    },
  },
  tokens: {
    async verify(token) {
      await later(700)
      if (token.length < 8 || token.includes('errato')) return { ok: false, error: 'token_invalid' }
      const project = /listino/i.test(token) ? LISTINO : ONPAGE.vasi
      return {
        ok: true,
        project_id: project.id,
        project_label: project.label,
        collections_with_files: 3,
        langs: ['it', 'en'],
      }
    },
    async verifyProject(id) {
      await later(700)
      const project = find(id).onpage_project ?? ONPAGE.vasi
      return {
        ok: true,
        project_id: project.id,
        project_label: project.label,
        collections_with_files: 3,
        langs: ['it', 'en'],
      }
    },
  },
  settings: {
    get: async () => clone(settings),
    async set(patch) {
      settings = { ...settings, ...patch }
      settingsChanged.emit(clone(settings))
      return clone(settings)
    },
    onChanged: listener => settingsChanged.add(listener),
  },
  app: {
    version: async () => clone(version),
    async checkForUpdates() {
      await later(600)
      version.checked_at = new Date().toISOString()
      versionChanged.emit(clone(version))
      return clone(version)
    },
    status: async () => status(),
    onStatus: listener => statusChanged.add(listener),
    onVersion: listener => versionChanged.add(listener),
    openExternal: async url => void window.open(url, '_blank'),
    copyText: async text => navigator.clipboard?.writeText(text),
    onCommand: listener => commands.add(listener),
    openLicenses: () => command(async () => undefined),
    log: (level, message) => console[level](message),
    // In a browser the panel and the window are one page: the command runs here
    showMainWindow: command => command && commands.emit(command),
    quit: () => undefined,
    window: {
      minimize: () => undefined,
      toggleMaximize: () => undefined,
      close: () => undefined,
      onFocusChanged: () => () => undefined,
    },
  },
}

/** The download of Vasi e accessori goes on, as the engine would report it */
function tick(): void {
  const p = projects.find(x => x.id == 'vasi')
  const progress = p?.runtime.phase == 'downloading' ? p.runtime.progress : undefined
  if (!p || !progress) return
  const speed = (3.6 + Math.random() * 1.4) * MB
  progress.speed_bps = speed
  progress.bytes_done = Math.min(progress.bytes_total, progress.bytes_done + speed / 2)
  progress.downloaded = Math.min(progress.total, progress.downloaded + 3)
  progress.eta_seconds = Math.round((progress.bytes_total - progress.bytes_done) / speed)
  const added = [entry({ name: `vaso-${progress.downloaded}.jpg`, size: 900 * 1024, outcome: 'downloaded' })]
  activity.vasi = [...(activity.vasi ?? []), ...added].slice(-200)
  emitProjects()
  activityAdded.emit('vasi', clone(added))
}

export function installFakeDesktop(): void {
  window.desktop = desktop
  if (!params.has('freeze')) setInterval(tick, 500)
}

/** For the dev scenes: send a command as main would */
export const sendCommand = (command: AppCommand): void => commands.emit(command)
