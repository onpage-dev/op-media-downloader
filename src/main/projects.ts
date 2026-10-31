/**
 * Projects as main sees them: configuration from the store, live runtime from
 * the engine, persistence of results and plans, and the operations the
 * renderer, the tray and the menus ask for.
 */
import crypto from 'crypto'
import { EventEmitter } from 'events'
import path from 'path'
import { DeleteProjectOptions, NewProjectInput, ProjectPatch } from '../shared/desktop-api'
import { DeleteFilesResult, EngineProject, EngineToMain } from '../shared/engine-protocol'
import {
  ActivityEntry,
  AppStatus,
  DuplicateGroup,
  FailedEntry,
  FolderInfo,
  FolderProblem,
  Issue,
  IssueCode,
  ProjectId,
  ProjectRuntime,
  ProjectView,
  SyncResult,
  TokenCheck,
} from '../shared/models'
import { EngineHost } from './engine-host'
import { log } from './log'
import { AppStore, StoredProject } from './store'

/** Issues that still make sense after a restart */
const PERSISTED_ISSUES: IssueCode[] = [
  'token_invalid',
  'project_unavailable',
  'listing_failed',
  'folder_unreachable',
  'folder_not_writable',
  'folder_protected',
  'disk_full',
  'duplicates',
  'failed_files',
  'copies_instead_of_links',
  'name_conflicts',
  'cleanup_needs_confirmation',
  'interrupted',
]

/** Folder problems that make a project impossible to save */
const BLOCKING_PROBLEMS: FolderProblem[] = ['protected', 'used_by_other_project']

const AUTO_RETRY_DELAY_MS = 60_000

export class ProjectService {
  private runtimes = new Map<ProjectId, ProjectRuntime>()
  private emitter = new EventEmitter()
  private change_timer?: NodeJS.Timeout
  /** Jobs already retried automatically, so a retry never loops */
  private auto_retried = new Set<string>()

  constructor(
    private store: AppStore,
    private engine: EngineHost,
  ) {
    engine.onMessage(message => this.onEngine(message))
    engine.onCrash(() => this.onEngineCrash())
  }

  /* ---------------------------------------------------------------- reading */

  views(): ProjectView[] {
    return this.store.projects.map(project => this.toView(project))
  }

  view(id: ProjectId): ProjectView | undefined {
    const project = this.store.project(id)
    return project && this.toView(project)
  }

  isRunning(): boolean {
    return [...this.runtimes.values()].some(runtime => runtime.phase != 'idle')
  }

  status(online: boolean): AppStatus {
    const views = this.views()
    return {
      online,
      running_jobs: views.filter(view => view.runtime.phase != 'idle').length,
      speed_bps: views.reduce((sum, view) => sum + (view.runtime.progress?.speed_bps ?? 0), 0),
      total_files: views.reduce(
        (sum, view) => sum + (view.runtime.plan?.remote_names ?? view.runtime.last_result?.total ?? 0),
        0,
      ),
      total_bytes: views.reduce((sum, view) => sum + (view.runtime.plan?.remote_bytes ?? 0), 0),
    }
  }

  revealToken(id: ProjectId): string {
    const project = this.require(id)
    return this.store.token(project)
  }

  /* ---------------------------------------------------------------- events */

  onChanged(listener: (views: ProjectView[]) => void): () => void {
    return this.on('changed', listener)
  }

  onActivity(listener: (id: ProjectId, entries: ActivityEntry[]) => void): () => void {
    return this.on('activity', listener)
  }

  onResult(listener: (view: ProjectView, result: SyncResult) => void): () => void {
    return this.on('result', listener)
  }

  /* ---------------------------------------------------------------- editing */

  async create(input: NewProjectInput): Promise<ProjectView> {
    const label = input.label?.trim()
    const token = input.token?.trim()
    const folder = normalizeFolder(input.folder)
    if (!label || !token || !folder) throw new Error('invalid_input')

    const info = await this.inspect(folder)
    assertUsable(info)

    const project: StoredProject = {
      id: crypto.randomUUID(),
      label,
      folder,
      keep_old_files: !!input.keep_old_files,
      created_at: new Date().toISOString(),
      ...this.store.encryptToken(token),
      folder_info: info,
    }
    this.store.saveProject(project)
    this.configureEngine()
    this.changed()
    log('info', `Project ${project.id} created`)
    if (input.sync_now) this.sync(project.id)
    return this.toView(project)
  }

  async update(id: ProjectId, patch: ProjectPatch): Promise<ProjectView> {
    const current = this.require(id)
    if (this.runtime(current).phase != 'idle') throw new Error('project_busy')

    const next: StoredProject = { ...current }
    let reset = false
    if (patch.label !== undefined) {
      const label = patch.label.trim()
      if (!label) throw new Error('invalid_input')
      next.label = label
    }
    if (patch.token !== undefined) {
      const token = patch.token.trim()
      if (!token) throw new Error('invalid_input')
      if (token != this.store.token(current)) {
        Object.assign(next, this.store.encryptToken(token))
        reset = true
      }
    }
    if (patch.folder !== undefined) {
      const folder = normalizeFolder(patch.folder)
      if (!folder) throw new Error('invalid_input')
      if (folder != current.folder) {
        const info = await this.inspect(folder, id)
        assertUsable(info)
        next.folder = folder
        next.folder_info = info
        reset = true
      }
    }
    if (patch.keep_old_files !== undefined && patch.keep_old_files != current.keep_old_files) {
      next.keep_old_files = patch.keep_old_files
      /** The plan was computed with the other rule */
      next.plan = undefined
      this.runtimes.delete(id)
    }
    if (reset) {
      /** Another project or another folder: what we knew does not apply */
      next.plan = undefined
      next.issues = []
      next.last_result = undefined
      this.runtimes.delete(id)
      this.engine.command({ type: 'forget', project_id: id })
    }
    this.store.saveProject(next)
    this.configureEngine()
    this.changed()
    return this.toView(next)
  }

  async remove(id: ProjectId, options: DeleteProjectOptions): Promise<void> {
    const project = this.require(id)
    if (this.runtime(project).phase != 'idle') {
      this.stop(id)
      await this.waitIdle([id], 30_000)
    }
    if (options.delete_files) {
      const result = await this.engine.request<DeleteFilesResult>({
        type: 'delete_project_files',
        project: this.engineProject(project),
      })
      log(
        'info',
        `Project ${id} files removed: ${result.removed_files} files, folder ${result.removed_folder ? 'removed' : `kept (${result.kept_entries} other entries)`}`,
      )
    }
    this.engine.command({ type: 'forget', project_id: id })
    this.runtimes.delete(id)
    this.store.removeProject(id)
    this.configureEngine()
    this.changed()
    log('info', `Project ${id} removed`)
  }

  /* ---------------------------------------------------------------- jobs */

  sync(id: ProjectId, full_listing?: boolean): void {
    const project = this.require(id)
    if (this.runtime(project).phase != 'idle') return
    this.markStarting(project, 'sync')
    this.engine.command({ type: 'sync', project: this.engineProject(project), full_listing })
  }

  syncAll(): void {
    for (const project of this.store.projects) this.sync(project.id)
  }

  download(id: ProjectId): void {
    const project = this.require(id)
    if (this.runtime(project).phase != 'idle') return
    this.markStarting(project, 'download')
    this.engine.command({ type: 'download', project: this.engineProject(project) })
  }

  retryFailed(id: ProjectId): void {
    const project = this.require(id)
    if (this.runtime(project).phase != 'idle') return
    this.markStarting(project, 'retry_failed')
    this.engine.command({ type: 'retry_failed', project: this.engineProject(project) })
  }

  confirmCleanup(id: ProjectId): void {
    const project = this.require(id)
    if (this.runtime(project).phase != 'idle') return
    this.markStarting(project, 'cleanup')
    this.engine.command({ type: 'confirm_cleanup', project: this.engineProject(project) })
  }

  stop(id: ProjectId): void {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.phase == 'idle') return
    this.runtimes.set(id, { ...runtime, phase: 'stopping' })
    this.engine.command({ type: 'stop', project_id: id })
    this.changed()
  }

  /** Stops every job and waits for the engine to save its work */
  async stopAll(timeout_ms = 15_000): Promise<void> {
    const running = [...this.runtimes.entries()].filter(([, runtime]) => runtime.phase != 'idle').map(([id]) => id)
    for (const id of running) this.stop(id)
    await this.waitIdle(running, timeout_ms)
  }

  getActivity(id: ProjectId, limit?: number): Promise<ActivityEntry[]> {
    this.require(id)
    return this.engine.request<ActivityEntry[]>({ type: 'get_activity', project_id: id, limit })
  }

  getFailed(id: ProjectId): Promise<FailedEntry[]> {
    this.require(id)
    return this.engine.request<FailedEntry[]>({ type: 'get_failed', project_id: id })
  }

  getDuplicates(id: ProjectId): Promise<DuplicateGroup[]> {
    const project = this.require(id)
    return this.engine.request<DuplicateGroup[]>({ type: 'get_duplicates', project: this.engineProject(project) })
  }

  verifyToken(token: string): Promise<TokenCheck> {
    const value = token.trim()
    if (!value) return Promise.resolve({ ok: false, error: 'token_invalid' })
    return this.engine.request<TokenCheck>({ type: 'verify_token', token: value }, 60_000)
  }

  inspect(folder: string, project_id?: ProjectId): Promise<FolderInfo> {
    return this.engine.request<FolderInfo>({ type: 'inspect_folder', path: normalizeFolder(folder), project_id }, 60_000)
  }

  /** Refreshes kind, free space and hard links of every folder, one at a time */
  async refreshFolders(): Promise<void> {
    for (const project of this.store.projects) await this.refreshFolder(project.id)
  }

  async refreshFolder(id: ProjectId): Promise<void> {
    const project = this.store.project(id)
    if (!project) return
    try {
      const info = await this.inspect(project.folder, id)
      this.store.patchProject(id, { folder_info: info })
      this.changed()
    } catch (error) {
      log('warn', `Folder inspection failed for ${id}`, error)
    }
  }

  configureEngine(concurrency?: number): void {
    this.engine.command({ type: 'configure', concurrency, project_folders: this.projectFolders() })
  }

  projectFolders(): { id: ProjectId; folder: string }[] {
    return this.store.projects.map(project => ({ id: project.id, folder: project.folder }))
  }

  /* ---------------------------------------------------------------- engine */

  private onEngine(message: EngineToMain): void {
    switch (message.kind) {
      case 'state': {
        const project = this.store.project(message.project_id)
        if (!project) return
        const runtime: ProjectRuntime = {
          ...message.runtime,
          /** The engine may not know runs older than this session */
          last_result: message.runtime.last_result ?? this.runtime(project).last_result,
        }
        this.runtimes.set(message.project_id, runtime)
        if (runtime.phase == 'idle') this.persist(project, runtime)
        this.changed()
        return
      }
      case 'activity':
        this.emitter.emit('activity', message.project_id, message.entries)
        return
      case 'result':
        this.handleResult(message.project_id, message.result)
        return
    }
  }

  private handleResult(id: ProjectId, result: SyncResult): void {
    const project = this.store.project(id)
    if (!project) return
    const runtime = this.runtime(project)
    /** A comparison that leaves files to download is not a finished sync */
    const finished = result.job != 'sync' || !(runtime.plan && runtime.plan.to_download_names > 0)
    const next_runtime: ProjectRuntime = {
      ...runtime,
      phase: 'idle',
      progress: undefined,
      last_result: finished || result.outcome == 'failed' ? result : runtime.last_result,
    }
    this.runtimes.set(id, next_runtime)
    const saved = this.persist(project, next_runtime)
    this.changed()
    log(
      'info',
      `Project ${id} ${result.job} ${result.outcome}: ${result.downloaded} downloaded, ${result.linked} linked, ${result.removed} removed, ${result.failed} failed`,
    )
    this.emitter.emit('result', this.toView(saved), result)
    this.scheduleAutoRetry(id, result)
    void this.refreshFolder(id)
  }

  private onEngineCrash(): void {
    const at = new Date().toISOString()
    for (const [id, runtime] of this.runtimes) {
      if (runtime.phase == 'idle') continue
      const issues: Issue[] = [{ code: 'interrupted', severity: 'warning', at }, ...runtime.issues]
      const next = { ...runtime, phase: 'idle' as const, progress: undefined, job: undefined, issues }
      this.runtimes.set(id, next)
      const project = this.store.project(id)
      if (project) this.persist(project, next)
    }
    this.changed()
  }

  private scheduleAutoRetry(id: ProjectId, result: SyncResult): void {
    if (!this.store.settings.auto_retry_failed) return
    if (result.failed == 0 || result.job == 'retry_failed' || result.outcome == 'stopped') return
    const key = `${id}:${result.started_at}`
    if (this.auto_retried.has(key)) return
    this.auto_retried.add(key)
    setTimeout(() => {
      const project = this.store.project(id)
      if (project && this.runtime(project).phase == 'idle') this.retryFailed(id)
    }, AUTO_RETRY_DELAY_MS)
  }

  /* ---------------------------------------------------------------- helpers */

  private toView(project: StoredProject): ProjectView {
    return {
      id: project.id,
      label: project.label,
      folder: project.folder,
      keep_old_files: project.keep_old_files,
      created_at: project.created_at,
      has_token: !!(project.token_enc || project.token_plain),
      runtime: this.runtime(project),
      folder_info: project.folder_info,
    }
  }

  private runtime(project: StoredProject): ProjectRuntime {
    return (
      this.runtimes.get(project.id) ?? {
        phase: 'idle',
        plan: project.plan,
        last_result: project.last_result,
        issues: project.issues ?? [],
      }
    )
  }

  private persist(project: StoredProject, runtime: ProjectRuntime): StoredProject {
    return (
      this.store.patchProject(project.id, {
        plan: runtime.plan,
        last_result: runtime.last_result,
        issues: runtime.issues.filter(issue => PERSISTED_ISSUES.includes(issue.code)),
      }) ?? project
    )
  }

  /** Shows the job as started at once, before the engine's first state */
  private markStarting(project: StoredProject, job: ProjectRuntime['job']): void {
    const runtime = this.runtime(project)
    this.runtimes.set(project.id, {
      ...runtime,
      phase: 'preparing',
      job,
      issues: runtime.issues.filter(issue => issue.code != 'interrupted'),
    })
    this.changed()
  }

  private engineProject(project: StoredProject): EngineProject {
    return {
      id: project.id,
      label: project.label,
      token: this.store.token(project),
      folder: project.folder,
      keep_old_files: project.keep_old_files,
    }
  }

  private require(id: ProjectId): StoredProject {
    const project = this.store.project(id)
    if (!project) throw new Error('project_not_found')
    return project
  }

  private waitIdle(ids: ProjectId[], timeout_ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = (): boolean => ids.every(id => (this.runtimes.get(id)?.phase ?? 'idle') == 'idle')
      if (done()) return resolve()
      const timer = setTimeout(finish, timeout_ms)
      const off = this.onChanged(() => {
        if (done()) finish()
      })
      function finish(): void {
        clearTimeout(timer)
        off()
        resolve()
      }
    })
  }

  private changed(): void {
    if (this.change_timer) return
    this.change_timer = setTimeout(() => {
      this.change_timer = undefined
      this.emitter.emit('changed', this.views())
    }, 100)
  }

  private on(event: string, listener: (...args: any[]) => void): () => void {
    this.emitter.on(event, listener)
    return () => this.emitter.off(event, listener)
  }
}

function normalizeFolder(folder: string): string {
  const trimmed = folder?.trim()
  if (!trimmed) return ''
  const normalized = path.normalize(trimmed)
  /** Keep roots as they are (`C:\`, `/`), drop trailing separators elsewhere */
  return normalized.length > path.parse(normalized).root.length
    ? normalized.replace(/[\\/]+$/, '')
    : normalized
}

function assertUsable(info: FolderInfo): void {
  const blocking = info.problems.find(problem => BLOCKING_PROBLEMS.includes(problem))
  if (blocking) throw new Error(`folder_${blocking}`)
}
