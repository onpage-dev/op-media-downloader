/**
 * Projects as main sees them: configuration from the store, live runtime from
 * the engine, persistence of results and plans, and the operations the
 * renderer, the tray and the menus ask for. Creating, editing and removing
 * projects run one at a time; a removed project leaves the list at once, its
 * job and the deletion of its files end in the background.
 */
import crypto from 'crypto'
import { shell } from 'electron'
import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import { DeleteProjectOptions, NewProjectInput, ProjectPatch } from '../shared/desktop-api'
import { DeleteFilesResult, EngineProject, EngineToMain } from '../shared/engine-protocol'
import {
  ActivityEntry,
  AppStatus,
  DuplicatePage,
  FailedPage,
  FolderInfo,
  FolderProblem,
  Issue,
  IssueCode,
  JobKind,
  PageQuery,
  ProjectId,
  ProjectRuntime,
  ProjectView,
  SyncResult,
  TokenCheck,
} from '../shared/models'
import { EngineHost, NO_TIMEOUT } from './engine-host'
import { log } from './log'
import { AppStore, StoredProject } from './store'

/** What projects use of the engine host (the tests give a fake one) */
export type Engine = Pick<
  EngineHost,
  'available' | 'revive' | 'command' | 'request' | 'onMessage' | 'onCrash' | 'onUnavailable'
>

/** A removed project whose files could not be deleted */
export interface RemovedProject {
  id: ProjectId
  label: string
  folder: string
}

/** Issues that still make sense after a restart */
const PERSISTED_ISSUES: IssueCode[] = [
  'token_invalid',
  'project_unavailable',
  'listing_failed',
  'unexpected',
  'listing_incomplete',
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
const BLOCKING_PROBLEMS: FolderProblem[] = ['protected', 'used_by_other_project', 'foreign_data']

/** The engine command of each job but «Sincronizza» */
const JOB_COMMANDS = { download: 'download', retry_failed: 'retry_failed', cleanup: 'confirm_cleanup' } as const

const AUTO_RETRY_DELAY_MS = 60_000
/** How long the job of a removed project gets to stop (the engine host restarts a hung engine after a minute) */
const STOP_WAIT_MS = 90_000
/** The engine answers these while it restarts or the job still stops: the deletion is tried again */
const DELETE_RETRY_ERRORS = ['project_busy', 'engine_crashed']
const DELETE_ATTEMPTS = 3
/** A share that does not answer counts as missing after this */
const FOLDER_CHECK_MS = 10_000

/** The detail of the `unexpected` issue of every project while the engine is down */
export const ENGINE_DOWN = 'The sync engine keeps stopping: it is started again with the next job'

export class ProjectService {
  private runtimes = new Map<ProjectId, ProjectRuntime>()
  private emitter = new EventEmitter()
  private change_timer?: NodeJS.Timeout
  /** Jobs already retried automatically, so a retry never loops */
  private auto_retried = new Set<string>()
  /** Removed projects whose files are being deleted: their folders stay taken meanwhile */
  private deleting = new Map<ProjectId, EngineProject>()
  /** Creating, editing and removing run one at a time: two creates could take the same folder */
  private edits: Promise<unknown> = Promise.resolve()

  constructor(
    private store: AppStore,
    private engine: Engine,
  ) {
    engine.onMessage(message => this.onEngine(message))
    engine.onCrash(() => this.onEngineCrash())
    engine.onUnavailable(() => this.onEngineUnavailable())
  }

  /* ---------------------------------------------------------------- reading */

  views(): ProjectView[] {
    return this.store.projects.map(project => this.toView(project))
  }

  /** A job runs (also the one of a removed project, while it stops) */
  isRunning(): boolean {
    return [...this.runtimes.values()].some(runtime => runtime.phase != 'idle')
  }

  /** The files of a removed project are being deleted */
  isDeleting(): boolean {
    return this.deleting.size > 0
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

  /** The folder of a project as recorded here, when it is there: the page never names a path to open */
  async openFolder(id: ProjectId): Promise<void> {
    const folder = this.require(id).folder
    if (!(await isDirectory(folder))) throw new Error('open_failed')
    const error = await shell.openPath(folder)
    if (error) throw new Error('open_failed')
  }

  /** The stored token of a project, verified without it reaching the page */
  verifyProjectToken(id: ProjectId): Promise<TokenCheck> {
    return this.verifyToken(this.store.token(this.require(id)))
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

  onDeleteFailed(listener: (project: RemovedProject, error: unknown) => void): () => void {
    return this.on('delete_failed', listener)
  }

  /* ---------------------------------------------------------------- editing */

  create(input: NewProjectInput): Promise<ProjectView> {
    return this.serialized(async () => {
      const label = input.label.trim()
      const token = input.token.trim()
      if (!label || !token) throw new Error('invalid_input')
      const { folder, info } = await this.checkedFolder(input.folder)

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
      if (input.sync_now) this.startJob(project.id, 'sync')
      return this.toView(project)
    })
  }

  update(id: ProjectId, patch: ProjectPatch): Promise<ProjectView> {
    return this.serialized(async () => {
      const current = this.require(id)
      this.requireIdle(current)

      const changes: Partial<StoredProject> = {}
      let reset = false
      if (patch.label !== undefined) {
        const label = patch.label.trim()
        if (!label) throw new Error('invalid_input')
        changes.label = label
      }
      if (patch.token !== undefined) {
        const token = patch.token.trim()
        if (!token) throw new Error('invalid_input')
        if (token != this.store.token(current)) {
          Object.assign(changes, this.store.encryptToken(token))
          reset = true
        }
      }
      if (patch.folder !== undefined) {
        const folder = normalizeFolder(patch.folder)
        if (folder != current.folder) {
          const checked = await this.checkedFolder(folder, id)
          changes.folder = checked.folder
          changes.folder_info = checked.info
          reset = true
        }
      }

      /** The folder inspection takes a while: the project as it is now, and still idle */
      const latest = this.require(id)
      this.requireIdle(latest)
      const next: StoredProject = { ...latest, ...changes }
      if (patch.keep_old_files !== undefined && patch.keep_old_files != latest.keep_old_files) {
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
    })
  }

  /**
   * Removes the project from the list at once. Its job is stopped and, when
   * asked, its files are deleted in the background, with no time limit: on a
   * slow share with 100k names it takes long, and the project is already
   * gone, so it cannot be removed twice.
   */
  remove(id: ProjectId, options: DeleteProjectOptions): Promise<void> {
    return this.serialized(async () => {
      const project = this.require(id)
      const target = this.engineProject(project)
      if (options.delete_files) this.deleting.set(id, target)
      /** The runtime of a running job stays until the engine says it ended */
      if (this.runtime(project).phase == 'idle') this.runtimes.delete(id)
      this.store.removeProject(id)
      this.configureEngine()
      this.changed()
      log('info', `Project ${id} removed${options.delete_files ? ': deleting its files' : ''}`)
      void (options.delete_files ? this.deleteFiles(target) : this.forget(id))
    })
  }

  /* ---------------------------------------------------------------- jobs */

  /** Starts a job unless one runs; an engine that was given up is started again */
  startJob(id: ProjectId, job: JobKind, options: { full_listing?: boolean } = {}): void {
    const project = this.require(id)
    if (this.runtime(project).phase != 'idle') return
    this.engineUp()
    this.markStarting(project, job)
    const target = this.engineProject(project)
    this.engine.command(
      job == 'sync'
        ? { type: 'sync', project: target, full_listing: options.full_listing }
        : { type: JOB_COMMANDS[job], project: target },
    )
  }

  syncAll(): void {
    for (const project of this.store.projects) this.startJob(project.id, 'sync')
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

  getFailed(id: ProjectId, page: PageQuery): Promise<FailedPage> {
    this.require(id)
    return this.engine.request<FailedPage>({ type: 'get_failed', project_id: id, ...page })
  }

  /** The first page of a big project reads the listing cache: up to a minute */
  getDuplicates(id: ProjectId, page: PageQuery): Promise<DuplicatePage> {
    const project = this.require(id)
    return this.engine.request<DuplicatePage>(
      { type: 'get_duplicates', project: this.engineProject(project), ...page },
      60_000,
    )
  }

  verifyToken(token: string): Promise<TokenCheck> {
    const value = token.trim()
    if (!value) return Promise.resolve({ ok: false, error: 'token_invalid' })
    this.engineUp()
    return this.engine.request<TokenCheck>({ type: 'verify_token', token: value }, 60_000)
  }

  /** A folder the user picked */
  inspect(folder: string, project_id?: ProjectId): Promise<FolderInfo> {
    this.engineUp()
    return this.inspectFolder(folder, project_id)
  }

  private async inspectFolder(folder: string, project_id?: ProjectId): Promise<FolderInfo> {
    const info = await this.engine.request<FolderInfo>(
      { type: 'inspect_folder', path: normalizeFolder(folder), project_id },
      60_000,
    )
    /** The engine names the other project by id: the user knows it by its label */
    const other = info.problems.includes('used_by_other_project') ? info.problem_detail : undefined
    if (other) info.problem_detail = this.store.project(other)?.label ?? this.deleting.get(other)?.label ?? other
    return info
  }

  /** Refreshes kind, free space and hard links of every folder, one at a time */
  async refreshFolders(): Promise<void> {
    for (const project of this.store.projects) await this.refreshFolder(project.id)
  }

  async refreshFolder(id: ProjectId): Promise<void> {
    const project = this.store.project(id)
    if (!project) return
    try {
      const info = await this.inspectFolder(project.folder, id)
      this.store.patchProject(id, { folder_info: info })
      this.changed()
    } catch (error) {
      log('warn', `Folder inspection failed for ${id}`, error)
    }
  }

  configureEngine(concurrency?: number): void {
    this.engine.command({ type: 'configure', concurrency, project_folders: this.projectFolders() })
  }

  /** The folders of the projects, and of the removed ones whose files are being deleted */
  projectFolders(): { id: ProjectId; folder: string }[] {
    return [
      ...this.store.projects.map(project => ({ id: project.id, folder: project.folder })),
      ...[...this.deleting.values()].map(project => ({ id: project.id, folder: project.folder })),
    ]
  }

  /* ---------------------------------------------------------------- removed projects */

  /** The job of a removed project ends, then the engine drops what it kept of it */
  private async forget(id: ProjectId): Promise<void> {
    await this.stopRemoved(id)
    this.runtimes.delete(id)
    this.engine.command({ type: 'forget', project_id: id })
  }

  /** The engine answers `project_busy` while a job of the project runs: it is stopped first */
  private async deleteFiles(project: EngineProject): Promise<void> {
    const id = project.id
    try {
      for (let attempt = 1; ; attempt++) {
        await this.stopRemoved(id)
        this.engineUp()
        try {
          const result = await this.engine.request<DeleteFilesResult>(
            { type: 'delete_project_files', project },
            NO_TIMEOUT,
          )
          log(
            'info',
            `Project ${id} files removed: ${result.removed_files} files, folder ${result.removed_folder ? 'removed' : `kept (${result.kept_entries} other entries)`}`,
          )
          return
        } catch (error) {
          /** `code` or `code: detail` */
          const code = String((error as Error | undefined)?.message ?? error).split(':')[0]
          if (attempt >= DELETE_ATTEMPTS || !DELETE_RETRY_ERRORS.includes(code)) throw error
          log('warn', `Deleting the files of project ${id}: ${code}, trying again`)
        }
      }
    } catch (error) {
      log('error', `The files of project ${id} could not be deleted from ${project.folder}`, error)
      this.engine.command({ type: 'forget', project_id: id })
      this.emitter.emit(
        'delete_failed',
        { id, label: project.label, folder: project.folder } satisfies RemovedProject,
        error,
      )
    } finally {
      this.runtimes.delete(id)
      this.deleting.delete(id)
      this.configureEngine()
      this.changed()
    }
  }

  private async stopRemoved(id: ProjectId): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.phase == 'idle') return
    this.stop(id)
    await this.waitIdle([id], STOP_WAIT_MS)
  }

  /* ---------------------------------------------------------------- engine */

  private onEngine(message: EngineToMain): void {
    switch (message.kind) {
      case 'state': {
        const project = this.store.project(message.project_id)
        if (!project) return this.removedState(message.project_id, message.runtime)
        const runtime: ProjectRuntime = {
          ...message.runtime,
          /** Main decides what counts as the last completed run (see handleResult) */
          last_result: this.runtime(project).last_result,
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
        if (!this.store.project(message.project_id)) return this.removedState(message.project_id)
        this.handleResult(message.project_id, message.result)
        return
    }
  }

  /** A removed project whose job is still ending: only whether it runs matters (quitting, deleting its files) */
  private removedState(id: ProjectId, runtime?: ProjectRuntime): void {
    if (!this.runtimes.has(id)) return
    if (runtime && runtime.phase != 'idle') this.runtimes.set(id, runtime)
    else this.runtimes.delete(id)
    this.changed()
  }

  private handleResult(id: ProjectId, result: SyncResult): void {
    const project = this.store.project(id)
    if (!project) return
    const runtime = this.runtime(project)
    /**
     * «Sincronizzato» is the last run that completed: a comparison that leaves
     * files to download, a stop or a failure (shown by the issues) do not count
     */
    const finished =
      result.outcome == 'completed' && (result.job != 'sync' || !(runtime.plan && runtime.plan.to_download_names > 0))
    const next_runtime: ProjectRuntime = {
      ...runtime,
      phase: 'idle',
      progress: undefined,
      last_result: finished ? result : runtime.last_result,
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
      const project = this.store.project(id)
      if (!project) {
        this.runtimes.delete(id)
        continue
      }
      const issues: Issue[] = [{ code: 'interrupted', severity: 'warning', at }, ...runtime.issues]
      const next = { ...runtime, phase: 'idle' as const, progress: undefined, job: undefined, issues }
      this.runtimes.set(id, next)
      this.persist(project, next)
    }
    this.changed()
  }

  /** The engine keeps stopping and is not restarted: every project says so until the user asks for work */
  private onEngineUnavailable(): void {
    const at = new Date().toISOString()
    for (const project of this.store.projects) {
      const runtime = this.runtime(project)
      const issues = runtime.issues.filter(issue => issue.detail != ENGINE_DOWN)
      this.runtimes.set(project.id, {
        ...runtime,
        phase: 'idle',
        progress: undefined,
        job: undefined,
        issues: [{ code: 'unexpected', severity: 'error', detail: ENGINE_DOWN, at }, ...issues],
      })
    }
    this.changed()
  }

  /** The user asks for work: an engine that was given up gets another chance */
  private engineUp(): void {
    if (this.engine.available) return
    for (const [id, runtime] of this.runtimes) {
      const issues = runtime.issues.filter(issue => issue.detail != ENGINE_DOWN)
      if (issues.length != runtime.issues.length) this.runtimes.set(id, { ...runtime, issues })
    }
    this.engine.revive()
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
      if (project && this.runtime(project).phase == 'idle') this.startJob(id, 'retry_failed')
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
      /** A token that cannot be decrypted here does not count: the page asks for one */
      has_token: this.store.hasToken(project),
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
        issues: runtime.issues.filter(issue => PERSISTED_ISSUES.includes(issue.code) && issue.detail != ENGINE_DOWN),
      }) ?? project
    )
  }

  /** Shows the job as started at once, before the engine's first state */
  private markStarting(project: StoredProject, job: JobKind): void {
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

  /** A folder a project can use: normalized, inspected by the engine, not protected nor taken */
  private async checkedFolder(raw: string, project_id?: ProjectId): Promise<{ folder: string; info: FolderInfo }> {
    const folder = normalizeFolder(raw)
    if (!folder) throw new Error('invalid_input')
    const info = await this.inspect(folder, project_id)
    const blocking = info.problems.find(problem => BLOCKING_PROBLEMS.includes(problem))
    if (blocking) throw new Error(`folder_${blocking}`)
    return { folder, info }
  }

  private require(id: ProjectId): StoredProject {
    const project = this.store.project(id)
    if (!project) throw new Error('project_not_found')
    return project
  }

  private requireIdle(project: StoredProject): void {
    if (this.runtime(project).phase != 'idle') throw new Error('project_busy')
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.edits.then(task)
    this.edits = run.catch(() => undefined)
    return run
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
  return normalized.length > path.parse(normalized).root.length ? normalized.replace(/[\\/]+$/, '') : normalized
}

/** The folder is there and is a folder (a share that does not answer is not) */
function isDirectory(folder: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>(resolve => (timer = setTimeout(() => resolve(false), FOLDER_CHECK_MS)))
  const check = fs.promises.stat(folder).then(
    stat => stat.isDirectory(),
    () => false,
  )
  return Promise.race([check, timeout]).finally(() => clearTimeout(timer))
}
