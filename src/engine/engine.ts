/**
 * The engine: one job at a time per project, projects side by side.
 * Receives `MainToEngine` messages, sends `EngineToMain` ones. This module
 * routes them, keeps a slot per project and runs the jobs; the flows are in
 * flows/, the folder work in folder-session.ts, what main sees in state.ts.
 */
import {
  DeleteFilesResult,
  EngineCommand,
  EngineInit,
  EngineProject,
  EngineRequest,
  EngineResponseData,
  EngineToMain,
  MainToEngine,
} from '../shared/engine-protocol'
import { FailedPage, JobKind, PageQuery, ProjectId, SyncResult } from '../shared/models'
import { deleteProjectFiles } from './delete-files'
import { duplicatesPage } from './duplicates'
import { errorDetail } from './errors'
import { runCleanup } from './flows/cleanup'
import { runDownload } from './flows/download'
import { resultOfError } from './flows/steps'
import { runSync } from './flows/sync'
import { inspectFolder } from './folder-inspect'
import { FetchLike } from './http'
import {
  EngineServices,
  Job,
  JobContext,
  LogLevel,
  ProjectSlot,
} from './job'
import { ListingStore } from './listing-store'
import { DEFAULT_DOMAIN, loadSchema, OnPageContext, verifyToken } from './onpage'
import { DEFAULT_TIMINGS, EngineTimings } from './timings'

export { DEFAULT_TIMINGS } from './timings'
export type { EngineTimings } from './timings'

export interface EngineDeps {
  fetch: FetchLike
  post: (message: EngineToMain) => void
  timings?: Partial<EngineTimings>
  now?: () => number
}

type Flow = (ctx: JobContext) => Promise<SyncResult>

export class Engine {
  private init?: EngineInit
  private slots = new Map<ProjectId, ProjectSlot>()
  private timings: EngineTimings
  private now: () => number
  private listings: ListingStore
  /** What the jobs see of the engine */
  private services: EngineServices

  constructor(private deps: EngineDeps) {
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings }
    this.now = deps.now ?? Date.now
    this.listings = new ListingStore({
      cache_dir: () => this.init?.cache_dir,
      max_age_ms: this.timings.listing_max_age_ms,
      now: this.now,
    })
    this.services = {
      timings: this.timings,
      fetch: deps.fetch,
      listings: this.listings,
      now: this.now,
      log: (level, message, project_id) => this.log(level, message, project_id),
      concurrency: () => Math.min(10, Math.max(1, this.init?.concurrency ?? 4)),
      instanceId: () => this.init?.instance_id ?? 'engine',
      apiDomain: () => this.init?.api_domain ?? DEFAULT_DOMAIN,
      projectFolders: () => this.init?.project_folders ?? [],
      onPageContext: (signal, onRetry) => this.onPageContext(signal, onRetry),
    }
  }

  /* ------------------------------------------------------------------ messages */

  receive(message: MainToEngine): void {
    if (message.kind == 'command') this.command(message.command)
    else void this.request(message.request_id, message.request)
  }

  command(command: EngineCommand): void {
    switch (command.type) {
      case 'init':
        // Nothing in the engine depends on init.app_version
        this.init = command.init
        this.post({ kind: 'ready' })
        return
      case 'configure':
        if (!this.init) return
        if (command.concurrency) this.init.concurrency = command.concurrency
        if (command.project_folders)
          this.init.project_folders = command.project_folders
        return
      case 'sync':
        this.start(command.project, 'sync', ctx =>
          runSync(ctx, !!command.full_listing),
        )
        return
      case 'download':
        this.start(command.project, 'download', ctx => runDownload(ctx, false))
        return
      case 'retry_failed':
        this.start(command.project, 'retry_failed', ctx =>
          runDownload(ctx, true),
        )
        return
      case 'confirm_cleanup': {
        // The removals the user saw: what the plan held back last
        const confirmed = new Set(
          this.slots.get(command.project.id)?.withheld ?? [],
        )
        this.start(command.project, 'cleanup', ctx => runCleanup(ctx, confirmed))
        return
      }
      case 'stop':
        this.stop(command.project_id)
        return
      case 'forget':
        void this.forget(command.project_id)
        return
    }
  }

  async request(request_id: number, request: EngineRequest): Promise<void> {
    try {
      const data = await this.answer(request)
      this.post({ kind: 'response', request_id, ok: true, data })
    } catch (error) {
      this.post({
        kind: 'response',
        request_id,
        ok: false,
        error: errorDetail(error),
      })
    }
  }

  private async answer(request: EngineRequest): Promise<EngineResponseData> {
    switch (request.type) {
      case 'inspect_folder':
        return inspectFolder(request.path, {
          project_id: request.project_id,
          project_folders: this.init?.project_folders ?? [],
          instance_id: this.init?.instance_id,
        })
      case 'verify_token':
        // The user is waiting in the form: two quick attempts, no long backoff
        return verifyToken(request.token, {
          ...this.onPageContext(),
          policy: {
            ...this.timings.api_policy,
            attempts: 2,
            max_retry_after_ms: 5_000,
          },
          timeout_ms: 20_000,
        })
      case 'get_activity':
        return (
          this.slots.get(request.project_id)?.activity.recent(request.limit) ??
          []
        )
      case 'get_failed':
        return this.failedPage(request.project_id, request)
      case 'get_duplicates': {
        // No slot for a project the engine does not run: the store keeps the names for a while
        const { id, token } = request.project
        return duplicatesPage(
          await this.listings.resolved(id, token),
          request,
          () =>
            this.listings.schema(id, token, () =>
              loadSchema(token, this.onPageContext()),
            ),
          message => this.log('warn', message, id),
        )
      }
      case 'delete_project_files':
        return this.deleteFiles(request.project)
    }
  }

  /** Waits for every running job and deletion to end (tests, shutdown) */
  async idle(): Promise<void> {
    await Promise.all(
      Array.from(this.slots.values(), s => Promise.all([s.job?.done, s.deleting])),
    )
  }

  /* ------------------------------------------------------------------ jobs */

  private start(project: EngineProject, kind: JobKind, flow: Flow): void {
    const slot = this.slot(project.id)
    if (slot.busy || slot.state.isClosed) {
      const why = slot.job
        ? `a ${slot.job.kind} job is already running`
        : slot.deleting
          ? 'its files are being deleted'
          : 'the project was forgotten'
      this.log('warn', `${kind} ignored: ${why}`, project.id)
      // Main showed the job as starting: the state says it is not
      if (!slot.job) slot.state.emit(true)
      return
    }
    const job = new Job(kind, project, new Date(this.now()).toISOString())
    slot.job = job
    slot.state.begin(kind)
    job.done = this.run({ engine: this.services, slot, job }, flow)
  }

  private async run(ctx: JobContext, flow: Flow): Promise<void> {
    let result: SyncResult
    try {
      result = await flow(ctx)
    } catch (error) {
      result = resultOfError(ctx, error)
    }
    ctx.slot.job = undefined
    ctx.slot.state.end(result)
  }

  private stop(project_id: ProjectId): void {
    const slot = this.slots.get(project_id)
    if (!slot?.job || slot.job.stopped) return
    slot.job.stop()
    slot.state.setPhase('stopping')
  }

  /** The project was removed or its token/folder changed: nothing more is sent, its memory goes */
  private async forget(project_id: ProjectId): Promise<void> {
    const slot = this.slots.get(project_id)
    if (slot) {
      slot.state.close()
      slot.job?.stop()
      // The slot stays while its job ends, so no new job takes the folder meanwhile
      await Promise.all([slot.job?.done, slot.deleting])
      if (this.slots.get(project_id) == slot) this.slots.delete(project_id)
    }
    // After the job: a listing that ended meanwhile kept its names
    this.listings.forget(project_id)
  }

  /**
   * Refused while a job of the project runs; no job starts while it runs.
   * The cache and the memory of the project go with its files.
   */
  private async deleteFiles(project: EngineProject): Promise<DeleteFilesResult> {
    if (this.slots.get(project.id)?.busy) throw new Error('project_busy')
    const slot = this.slot(project.id)
    const deleting = deleteProjectFiles(project, {
      instance_id: this.services.instanceId(),
      lock_stale_ms: this.timings.lock_stale_ms,
      lock_heartbeat_ms: this.timings.lock_heartbeat_ms,
    })
    slot.deleting = deleting.catch(() => undefined)
    let result: DeleteFilesResult
    try {
      result = await deleting
    } finally {
      slot.deleting = undefined
    }
    await this.listings.removeCache(project.id)
    await this.forget(project.id)
    return result
  }

  /* ------------------------------------------------------------------ helpers */

  private slot(id: ProjectId): ProjectSlot {
    let slot = this.slots.get(id)
    if (!slot) {
      slot = new ProjectSlot(id, {
        post: message => this.post(message),
        now: this.now,
        timings: this.timings,
      })
      this.slots.set(id, slot)
    }
    return slot
  }

  private failedPage(project_id: ProjectId, page: Partial<PageQuery>): FailedPage {
    const entries = this.slots.get(project_id)?.failed.list() ?? []
    const offset = Math.max(0, page.offset ?? 0)
    return {
      total: entries.length,
      entries: entries.slice(offset, offset + Math.max(1, page.limit ?? 50)),
    }
  }

  private onPageContext(
    signal?: AbortSignal,
    onRetry?: OnPageContext['onRetry'],
  ): OnPageContext {
    return {
      fetch: this.deps.fetch,
      domain: this.init?.api_domain ?? DEFAULT_DOMAIN,
      policy: this.timings.api_policy,
      timeout_ms: this.timings.api_timeout_ms,
      signal: () => signal,
      onRetry,
    }
  }

  private post(message: EngineToMain): void {
    this.deps.post(message)
  }

  private log(level: LogLevel, message: string, project_id?: ProjectId): void {
    this.post({ kind: 'log', level, message, project_id })
  }
}
