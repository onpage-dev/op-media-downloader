/**
 * The engine: one job at a time per project, projects side by side.
 * Receives `MainToEngine` messages, sends `EngineToMain` ones; everything
 * that touches On Page or a folder happens here.
 */
import { promises as fs } from 'fs'
import path from 'path'
import { OpFile, Schema } from 'onpage-js'
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
import {
  DuplicatePage,
  FailedPage,
  Issue,
  IssueCode,
  JobKind,
  JobPhase,
  PageQuery,
  PlanSummary,
  ProjectId,
  ProjectRuntime,
  SyncResult,
} from '../shared/models'
import { ActivityLog, FailedList } from './activity'
import { dataDirOwner, removeOwnDataEntries } from './data-dir'
import {
  AbortedError,
  errorDetail,
  folderJobError,
  HttpError,
  JobError,
} from './errors'
import { executePlan, ExecuteResult } from './executor'
import {
  inspectFolder,
  isInside,
  isProtectedPath,
  normalize,
} from './folder-inspect'
import { freeSpace, pathExists, reachable, unlinkQuiet } from './fsx'
import {
  API_RETRY,
  DOWNLOAD_RETRY,
  FetchLike,
  RetryPolicy,
  sleep,
} from './http'
import { LinkCapability } from './link'
import { listRemote, ListingResult, PAGE_SIZE, PARALLEL_PAGES } from './listing'
import { FolderLock } from './lock'
import { DATA_DIR, Manifest } from './manifest'
import { nameKey, resolveNames, ResolvedNames } from './names'
import {
  DEFAULT_DOMAIN,
  loadSchema,
  OnPageContext,
  storageLinker,
  thingEditUrl,
  verifyToken,
} from './onpage'
import { AdoptionStat, adoptionCandidates, buildPlan, Plan } from './plan'
import { ProgressTracker } from './progress'
import { runQueue } from './queue'
import { readIndexCache, writeIndexCache } from './remote-index'
import { scanFolder } from './scan'

export interface EngineTimings {
  state_interval_ms: number
  activity_interval_ms: number
  /** A listing kept in memory is reused by «Scarica» for this long */
  listing_max_age_ms: number
  api_policy: RetryPolicy
  download_policy: RetryPolicy
  api_timeout_ms: number
  headers_timeout_ms: number
  idle_timeout_ms: number
  page_size: number
  parallel_pages: number
  lock_stale_ms?: number
  lock_heartbeat_ms?: number
  /** A folder root that does not answer in this time is unreachable */
  reach_timeout_ms: number
}

export const DEFAULT_TIMINGS: EngineTimings = {
  state_interval_ms: 250,
  activity_interval_ms: 250,
  listing_max_age_ms: 30 * 60 * 1000,
  api_policy: API_RETRY,
  download_policy: DOWNLOAD_RETRY,
  api_timeout_ms: 120_000,
  headers_timeout_ms: 30_000,
  idle_timeout_ms: 60_000,
  page_size: PAGE_SIZE,
  parallel_pages: PARALLEL_PAGES,
  reach_timeout_ms: 15_000,
}

export interface EngineDeps {
  fetch: FetchLike
  post: (message: EngineToMain) => void
  timings?: Partial<EngineTimings>
  now?: () => number
}

interface LastListing {
  token: string
  listing: ListingResult
  resolved: ResolvedNames
  at: number
}

interface Job {
  kind: JobKind
  project: EngineProject
  controller: AbortController
  done: Promise<void>
}

class ProjectSlot {
  runtime: ProjectRuntime = { phase: 'idle', issues: [] }
  job?: Job
  activity: ActivityLog
  failed = new FailedList()
  last?: LastListing
  progress?: ProgressTracker
  /** Problems that ended the last job */
  job_issues: Issue[] = []
  /** Copies instead of links seen in this folder */
  copies = false
  rate_limited = false
  cleanup_confirmed = false
  withheld_removals = 0
  conflicts = 0
  duplicates = 0
  forgotten = false
  last_state_at = 0
  state_timer?: NodeJS.Timeout
  activity_timer?: NodeJS.Timeout
  /** After a restart: the names of the listing cache, for the duplicates tab */
  saved?: { token: string; resolved: ResolvedNames }
  /** After a restart: the schema, for the labels of the duplicates tab */
  schema?: { token: string; schema: Schema }

  constructor(public id: ProjectId, now: () => number) {
    this.activity = new ActivityLog(now)
  }
}

interface Prepared {
  folder: string
  data_dir: string
  lock: FolderLock
  manifest: Manifest
}

export class Engine {
  private init?: EngineInit
  private slots = new Map<ProjectId, ProjectSlot>()
  private timings: EngineTimings
  private now: () => number

  constructor(private deps: EngineDeps) {
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings }
    this.now = deps.now ?? Date.now
  }

  /* ------------------------------------------------------------------ messages */

  receive(message: MainToEngine): void {
    if (message.kind == 'command') this.command(message.command)
    else void this.request(message.request_id, message.request)
  }

  command(command: EngineCommand): void {
    switch (command.type) {
      case 'init':
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
        this.start(command.project, 'sync', job =>
          this.runSync(job, !!command.full_listing),
        )
        return
      case 'download':
        this.start(command.project, 'download', job =>
          this.runDownload(job, false),
        )
        return
      case 'retry_failed':
        this.start(command.project, 'retry_failed', job =>
          this.runDownload(job, true),
        )
        return
      case 'confirm_cleanup':
        this.slot(command.project.id).cleanup_confirmed = true
        this.start(command.project, 'cleanup', job => this.runCleanup(job))
        return
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
      case 'get_duplicates':
        return this.duplicates(request.project, request)
      case 'delete_project_files':
        return this.deleteProjectFiles(request.project)
    }
  }

  /** Waits for every running job to end (tests, shutdown) */
  async idle(): Promise<void> {
    await Promise.all(Array.from(this.slots.values()).map(s => s.job?.done))
  }

  /* ------------------------------------------------------------------ helpers */

  private post(message: EngineToMain): void {
    this.deps.post(message)
  }

  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    project_id?: ProjectId,
  ): void {
    this.post({ kind: 'log', level, message, project_id })
  }

  private slot(id: ProjectId): ProjectSlot {
    let slot = this.slots.get(id)
    if (!slot) {
      slot = new ProjectSlot(id, this.now)
      this.slots.set(id, slot)
    }
    return slot
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

  private cacheFile(project_id: ProjectId): string | undefined {
    if (!this.init?.cache_dir) return undefined
    return path.join(
      this.init.cache_dir,
      `${project_id.replace(/[^A-Za-z0-9_-]/g, '_')}.json.gz`,
    )
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  /* ------------------------------------------------------------------ state */

  private setPhase(slot: ProjectSlot, phase: JobPhase): void {
    slot.runtime.phase = phase
    this.emitState(slot, true)
  }

  private issues(slot: ProjectSlot): Issue[] {
    const at = this.iso()
    const out: Issue[] = [...slot.job_issues]
    const warn = (code: IssueCode, count?: number): void => {
      out.push({ code, severity: 'warning', count, at })
    }
    if (slot.rate_limited && slot.job) warn('rate_limited')
    if (slot.withheld_removals)
      warn('cleanup_needs_confirmation', slot.withheld_removals)
    const failed = slot.failed.retryable().length
    if (failed) warn('failed_files', failed)
    if (slot.duplicates) warn('duplicates', slot.duplicates)
    if (slot.conflicts) warn('name_conflicts', slot.conflicts)
    if (slot.copies) warn('copies_instead_of_links')
    return out
  }

  private emitState(slot: ProjectSlot, force = false): void {
    if (slot.forgotten) return
    const send = (): void => {
      slot.state_timer = undefined
      slot.last_state_at = this.now()
      slot.runtime.issues = this.issues(slot)
      slot.runtime.progress = slot.progress?.snapshot()
      this.post({
        kind: 'state',
        project_id: slot.id,
        runtime: structuredClone(slot.runtime),
      })
    }
    const wait =
      this.timings.state_interval_ms - (this.now() - slot.last_state_at)
    if (force || wait <= 0) {
      if (slot.state_timer) clearTimeout(slot.state_timer)
      send()
    } else if (!slot.state_timer) {
      slot.state_timer = setTimeout(send, wait)
    }
  }

  private flushActivity(slot: ProjectSlot): void {
    if (slot.forgotten) return
    const entries = slot.activity.takeChanged()
    if (entries.length)
      this.post({ kind: 'activity', project_id: slot.id, entries })
  }

  /* ------------------------------------------------------------------ jobs */

  private start(
    project: EngineProject,
    kind: JobKind,
    run: (job: Job) => Promise<SyncResult>,
  ): void {
    const slot = this.slot(project.id)
    slot.forgotten = false
    if (slot.job) {
      this.log(
        'warn',
        `A ${slot.job.kind} job is already running: ${kind} ignored`,
        project.id,
      )
      return
    }
    const controller = new AbortController()
    const job = { kind, project, controller } as Job
    slot.job = job
    slot.job_issues = []
    slot.rate_limited = false
    slot.runtime.job = kind
    slot.activity_timer = setInterval(
      () => this.flushActivity(slot),
      this.timings.activity_interval_ms,
    )
    this.setPhase(slot, 'preparing')
    job.done = (async (): Promise<void> => {
      const started_at = this.iso()
      let result: SyncResult
      try {
        result = await run(job)
      } catch (error) {
        result = this.failedResult(slot, kind, started_at, error)
      } finally {
        if (slot.activity_timer) clearInterval(slot.activity_timer)
        slot.activity_timer = undefined
      }
      this.flushActivity(slot)
      slot.job = undefined
      slot.progress = undefined
      slot.rate_limited = false
      slot.runtime.job = undefined
      slot.runtime.last_result = result
      slot.runtime.phase = 'idle'
      this.emitState(slot, true)
      if (!slot.forgotten)
        this.post({ kind: 'result', project_id: slot.id, result })
    })()
  }

  private failedResult(
    slot: ProjectSlot,
    kind: JobKind,
    started_at: string,
    error: unknown,
  ): SyncResult {
    const progress = slot.progress?.progress
    const stopped =
      error instanceof AbortedError || slot.job?.controller.signal.aborted
    let issue: Issue | undefined
    if (!stopped) {
      const job_error =
        folderJobError(error) ??
        new JobError('unexpected', 'Unexpected error', errorDetail(error))
      if (!(error instanceof JobError))
        this.log('error', `Job ${kind} failed: ${errorDetail(error)}`, slot.id)
      issue = {
        code: job_error.issue,
        severity:
          job_error.issue == 'offline' || job_error.issue == 'rate_limited'
            ? 'warning'
            : 'error',
        detail: job_error.detail ?? job_error.message,
        at: this.iso(),
      }
      slot.job_issues = [issue]
    }
    return {
      job: kind,
      started_at,
      ended_at: this.iso(),
      outcome: stopped ? 'stopped' : 'failed',
      total: progress?.total ?? 0,
      downloaded: progress?.downloaded ?? 0,
      linked: progress?.linked ?? 0,
      removed: progress?.removed ?? 0,
      already_present: progress?.already_present ?? 0,
      failed: progress?.failed ?? 0,
      bytes: progress?.bytes_done ?? 0,
      error: issue,
    }
  }

  private stop(project_id: ProjectId): void {
    const slot = this.slots.get(project_id)
    if (!slot?.job || slot.job.controller.signal.aborted) return
    slot.job.controller.abort()
    this.setPhase(slot, 'stopping')
  }

  private async forget(project_id: ProjectId): Promise<void> {
    const slot = this.slots.get(project_id)
    if (!slot) return
    slot.forgotten = true
    slot.job?.controller.abort()
    await slot.job?.done
    if (slot.state_timer) clearTimeout(slot.state_timer)
    this.slots.delete(project_id)
  }

  /** Folder checks, the lock and the manifest */
  private async prepare(job: Job): Promise<Prepared> {
    const project = job.project
    const folder = normalize(project.folder)
    if (isProtectedPath(folder)) {
      throw new JobError(
        'folder_protected',
        'This folder cannot be used',
        folder,
      )
    }
    const other = this.init?.project_folders.find(
      f =>
        f.id != project.id &&
        (isInside(folder, f.folder) || isInside(f.folder, folder)),
    )
    if (other)
      throw new JobError(
        'folder_protected',
        'The folder is used by another project',
        other.id,
      )
    const root =
      /^\\\\[^\\]+\\[^\\]+/.exec(folder)?.[0] ?? path.parse(folder).root
    if (!(await reachable(root, this.timings.reach_timeout_ms))) {
      throw new JobError(
        'folder_unreachable',
        'The folder cannot be reached',
        root,
      )
    }
    const data_dir = path.join(folder, DATA_DIR)
    const owner = await dataDirOwner(data_dir).catch(error => {
      throw folderJobError(error) ?? error
    })
    if (owner == 'foreign') {
      throw new JobError(
        'folder_protected',
        'The folder already has a "data" folder that the app did not create',
        data_dir,
      )
    }
    try {
      await fs.mkdir(data_dir, { recursive: true })
    } catch (error) {
      if (
        !(await pathExists(folder)) &&
        !(await pathExists(path.dirname(folder)))
      ) {
        throw new JobError(
          'folder_unreachable',
          'The folder cannot be reached',
          errorDetail(error),
        )
      }
      throw new JobError(
        'folder_not_writable',
        'The folder cannot be written',
        errorDetail(error),
      )
    }
    const lock = await FolderLock.acquire(data_dir, {
      instance_id: this.init?.instance_id ?? 'engine',
      project_id: project.id,
      stale_ms: this.timings.lock_stale_ms,
      heartbeat_ms: this.timings.lock_heartbeat_ms,
    }).catch(error => {
      throw folderJobError(error) ?? error
    })
    try {
      const { manifest, source, recovered } = await Manifest.load(
        data_dir,
        project.id,
      ).catch(error => {
        throw folderJobError(error) ?? error
      })
      if (source == 'link.json')
        this.log('info', 'Imported data/link.json from 1.x', project.id)
      if (recovered)
        this.log(
          'warn',
          'data/manifest.json was unreadable: rebuilt',
          project.id,
        )
      return { folder, data_dir, lock, manifest }
    } catch (error) {
      await lock.release()
      throw error
    }
  }

  /** The listing: reused from memory when fresh, otherwise incremental from the cache */
  private async listing(
    job: Job,
    slot: ProjectSlot,
    full: boolean,
    reuse: boolean,
  ): Promise<LastListing> {
    const fresh =
      slot.last &&
      slot.last.token == job.project.token &&
      this.now() - slot.last.at < this.timings.listing_max_age_ms
    if (reuse && fresh && slot.last!.listing.complete) return slot.last!
    this.setPhase(slot, 'listing')
    const cache_file = this.cacheFile(job.project.id)
    const cache =
      full || !cache_file ? undefined : await readIndexCache(cache_file)
    slot.progress = new ProgressTracker(
      { total: 0, bytes_total: 0, concurrency: this.concurrency() },
      this.now,
    )
    const listing = await listRemote({
      token: job.project.token,
      ctx: this.onPageContext(
        job.controller.signal,
        (error, _attempt, delay) => {
          if (error instanceof HttpError && error.status == 429) {
            slot.rate_limited = true
            this.log(
              'info',
              `On Page asked to slow down: waiting ${Math.round(
                delay / 1000,
              )} s`,
              slot.id,
            )
          }
          this.emitState(slot)
        },
      ),
      cache,
      full,
      page_size: this.timings.page_size,
      parallel: this.timings.parallel_pages,
      signal: job.controller.signal,
      now: this.now,
      onProgress: progress => {
        if (slot.progress) slot.progress.progress.listing = progress
        this.emitState(slot)
      },
      log: (level, message) => this.log(level, message, slot.id),
    })
    if (listing.complete && cache_file) {
      await writeIndexCache(cache_file, listing.index).catch(error =>
        this.log(
          'warn',
          `Listing cache not written: ${errorDetail(error)}`,
          slot.id,
        ),
      )
    }
    for (const failed of listing.failed_resources) {
      this.log(
        'warn',
        `Collection ${failed.label} not read: ${failed.error}`,
        slot.id,
      )
    }
    const resolved = resolveNames(listing.index)
    for (const entry of slot.failed.list())
      if (entry.reason == 'invalid_name') slot.failed.delete(entry.name)
    for (const bad of resolved.invalid) {
      slot.failed.set({
        name: bad.remote_name,
        token: bad.token,
        reason: 'invalid_name',
        attempts: 0,
        at: this.iso(),
      })
    }
    slot.duplicates = resolved.duplicates.length
    slot.last = { token: job.project.token, listing, resolved, at: this.now() }
    slot.saved = undefined
    return slot.last
  }

  /** Scan, adoption checks, plan. `signal` undefined: also after a stop (what is left) */
  private async compare(
    job: Job,
    slot: ProjectSlot,
    prepared: Prepared,
    last: LastListing,
    signal: AbortSignal | undefined = job.controller.signal,
  ): Promise<Plan> {
    if (signal) this.setPhase(slot, 'comparing')
    const scan = await scanFolder(prepared.folder).catch(error => {
      throw folderJobError(error) ?? error
    })
    // Leftovers of interrupted runs: ours by name
    const leftovers = [
      ...scan.data_leftovers.map(n => path.join(prepared.data_dir, n)),
      ...scan.folder_leftovers.map(n => path.join(prepared.folder, n)),
    ]
    await runQueue(leftovers, 8, async file => {
      await unlinkQuiet(file).catch(() => undefined)
    })
    const desired = last.resolved.desired
    const candidates = adoptionCandidates(desired, prepared.manifest, scan)
    const adoption = new Map<string, AdoptionStat>()
    await runQueue(
      candidates,
      8,
      async candidate => {
        const stat: AdoptionStat = {}
        try {
          const s = await fs.stat(path.join(prepared.folder, candidate.name), {
            bigint: true,
          })
          stat.name_ino = s.ino
          stat.name_size = Number(s.size)
        } catch {
          // gone: the plan sees it as a free name next time
        }
        if (scan.data_tokens.has(candidate.token)) {
          try {
            stat.blob_ino = (
              await fs.stat(path.join(prepared.data_dir, candidate.token), {
                bigint: true,
              })
            ).ino
          } catch {
            // no blob: only the size can tell
          }
        }
        adoption.set(candidate.key, stat)
      },
      signal,
    )
    if (signal?.aborted) throw new AbortedError()
    const plan = buildPlan({
      desired,
      manifest: prepared.manifest,
      scan,
      keep_old_files: job.project.keep_old_files,
      listing_complete: last.listing.complete,
      listing: last.listing.mode,
      cleanup_confirmed: slot.cleanup_confirmed,
      duplicates: last.resolved.duplicates.length,
      adoption,
    })
    slot.withheld_removals = plan.withheld_removals
    slot.conflicts = plan.conflicts.length
    slot.runtime.plan = { ...plan.summary, created_at: this.iso() }
    return plan
  }

  private concurrency(): number {
    return Math.min(10, Math.max(1, this.init?.concurrency ?? 4))
  }

  /**
   * `reset_failed`: this run decides again what failed (a download run, or a
   * sync that applies everything). A sync that only does bookkeeping keeps
   * the failures of the last download for the «Falliti» tab.
   */
  private async execute(
    job: Job,
    slot: ProjectSlot,
    prepared: Prepared,
    plan: Plan,
    reset_failed: boolean,
  ): Promise<ExecuteResult> {
    const total =
      plan.renames.length +
      plan.links.length +
      plan.downloads.reduce((sum, t) => sum + t.names.length, 0) +
      plan.remove_names.length
    const bytes_total = plan.downloads.reduce(
      (sum, t) => sum + (t.size ?? 0),
      0,
    )
    slot.progress = new ProgressTracker(
      { total, bytes_total, concurrency: this.concurrency() },
      this.now,
    )
    if (reset_failed) {
      for (const entry of slot.failed.list())
        if (entry.reason != 'invalid_name') slot.failed.delete(entry.name)
    }
    this.setPhase(slot, 'finishing')
    const capability: LinkCapability = {}
    const storageUrl = storageLinker(this.init?.api_domain ?? DEFAULT_DOMAIN)
    let result: ExecuteResult | undefined
    try {
      result = await executePlan({
        folder: prepared.folder,
        data_dir: prepared.data_dir,
        manifest: prepared.manifest,
        plan,
        fetch: this.deps.fetch,
        storageUrl,
        concurrency: this.concurrency(),
        signal: job.controller.signal,
        progress: slot.progress,
        activity: slot.activity,
        failed: slot.failed,
        capability,
        allow_removals: true,
        policy: this.timings.download_policy,
        headers_timeout_ms: this.timings.headers_timeout_ms,
        idle_timeout_ms: this.timings.idle_timeout_ms,
        onChange: () => this.emitState(slot),
        onStage: stage => {
          if (job.controller.signal.aborted) return
          this.setPhase(
            slot,
            stage == 'downloads' ? 'downloading' : 'finishing',
          )
        },
        onRateLimited: () => {
          slot.rate_limited = true
          this.emitState(slot)
        },
        log: (level, message) => this.log(level, message, slot.id),
        lost: () =>
          prepared.lock.lost
            ? new JobError(
                'folder_locked',
                'Another computer took over the folder',
              )
            : undefined,
        reach_timeout_ms: this.timings.reach_timeout_ms,
      })
      // A copy for a content with too many names says nothing about the folder
      if (capability.hardlinks !== undefined)
        slot.copies = !capability.hardlinks
      return result
    } finally {
      // A folder taken by another computer is its own now: our registry would overwrite its one
      const error = prepared.lock.lost
        ? undefined
        : await this.saveManifest(prepared.manifest)
      if (error) {
        this.log('error', `data/manifest.json not written: ${errorDetail(error)}`, slot.id)
        // The files are in place but not registered: the run must not look complete
        // eslint-disable-next-line no-unsafe-finally
        if (result) throw folderJobError(error) ?? error
      }
    }
  }

  /** The final save of the manifest, retried: a busy share or an antivirus can refuse it for a moment */
  private async saveManifest(manifest: Manifest): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        await manifest.flush()
        return undefined
      } catch (error) {
        if (attempt >= 3) return error
        await sleep(500 * attempt)
      }
    }
  }

  private summaryAfter(
    plan: Plan,
    executed: ExecuteResult,
    slot: ProjectSlot,
  ): PlanSummary {
    const before = plan.summary
    return {
      ...before,
      created_at: this.iso(),
      to_download: 0,
      to_download_names: 0,
      to_download_bytes: 0,
      to_link: 0,
      to_remove: slot.withheld_removals,
      up_to_date: before.up_to_date + executed.linked + executed.downloaded,
      conflicts: executed.conflicts,
      cleanup_needs_confirmation: slot.withheld_removals > 0,
    }
  }

  private resultOf(
    kind: JobKind,
    started_at: string,
    slot: ProjectSlot,
    outcome: SyncResult['outcome'],
  ): SyncResult {
    const p = slot.progress?.progress
    return {
      job: kind,
      started_at,
      ended_at: this.iso(),
      outcome,
      total: slot.runtime.plan?.remote_names ?? p?.total ?? 0,
      downloaded: p?.downloaded ?? 0,
      linked: p?.linked ?? 0,
      removed: p?.removed ?? 0,
      already_present: p?.already_present ?? 0,
      failed: p?.failed ?? 0,
      bytes: p?.bytes_done ?? 0,
    }
  }

  /** «Sincronizza»: list, compare; apply at once when nothing needs downloading */
  private async runSync(job: Job, full: boolean): Promise<SyncResult> {
    const slot = this.slot(job.project.id)
    const started_at = this.iso()
    const prepared = await this.prepare(job)
    try {
      const last = await this.listing(job, slot, full, false)
      const plan = await this.compare(job, slot, prepared, last)
      if (plan.downloads.length) {
        // Only bookkeeping now (adoptions, forgotten names); the rest waits for «Scarica»
        const bookkeeping = {
          ...plan,
          downloads: [],
          links: [],
          renames: [],
          remove_names: [],
          remove_tokens: [],
        }
        await this.execute(job, slot, prepared, bookkeeping, false)
        slot.runtime.plan = { ...plan.summary, created_at: this.iso() }
        return this.resultOf('sync', started_at, slot, 'completed')
      }
      const executed = await this.execute(job, slot, prepared, plan, true)
      if (plan.remove_names.length) slot.cleanup_confirmed = false
      if (job.controller.signal.aborted)
        return this.stopped(job, slot, prepared, last, started_at)
      slot.runtime.plan = this.summaryAfter(plan, executed, slot)
      return this.resultOf('sync', started_at, slot, 'completed')
    } finally {
      await this.release(prepared)
    }
  }

  /** Frees the folder: the lock goes, and data/ too when a first job left it empty */
  private async release(prepared: Prepared): Promise<void> {
    await prepared.lock.release()
    await fs.rmdir(prepared.data_dir).catch(() => undefined)
  }

  /** After a stop: what is left becomes the plan for the next «Scarica» */
  private async stopped(
    job: Job,
    slot: ProjectSlot,
    prepared: Prepared,
    last: LastListing,
    started_at: string,
  ): Promise<SyncResult> {
    const result = this.resultOf(job.kind, started_at, slot, 'stopped')
    const after = await this.compare(
      job,
      slot,
      prepared,
      last,
      undefined,
    ).catch(() => undefined)
    if (after) slot.runtime.plan = { ...after.summary, created_at: this.iso() }
    return result
  }

  /** «Scarica» (and «Riprova i falliti»): fresh compare, then the whole plan */
  private async runDownload(
    job: Job,
    only_failed: boolean,
  ): Promise<SyncResult> {
    const slot = this.slot(job.project.id)
    const started_at = this.iso()
    const retry = only_failed
      ? new Set(slot.failed.retryable().map(e => e.name))
      : undefined
    const prepared = await this.prepare(job)
    try {
      const last = await this.listing(job, slot, false, true)
      let plan = await this.compare(job, slot, prepared, last)
      if (retry && slot.last) {
        // Only what failed: downloads and links of those names, nothing else
        plan = {
          ...plan,
          downloads: plan.downloads
            .map(t => ({ ...t, names: t.names.filter(n => retry.has(n.name)) }))
            .filter(t => t.names.length),
          links: plan.links.filter(l => retry.has(l.name)),
          renames: [],
          remove_names: [],
          remove_tokens: [],
        }
      }
      await this.checkRoom(prepared, plan, slot)
      const executed = await this.execute(
        job,
        slot,
        prepared,
        plan,
        !only_failed,
      )
      if (plan.remove_names.length) slot.cleanup_confirmed = false
      if (job.controller.signal.aborted)
        return this.stopped(job, slot, prepared, last, started_at)
      const result = this.resultOf(job.kind, started_at, slot, 'completed')
      if (only_failed) {
        // Other work may still be pending: ask the folder
        const after = await this.compare(
          job,
          slot,
          prepared,
          last,
          undefined,
        ).catch(() => undefined)
        slot.runtime.plan = after
          ? { ...after.summary, created_at: this.iso() }
          : this.summaryAfter(plan, executed, slot)
      } else {
        slot.runtime.plan = this.summaryAfter(plan, executed, slot)
      }
      return result
    } finally {
      await this.release(prepared)
    }
  }

  /**
   * Before downloading: the contents, and the copies where the folder copies,
   * must fit. A clear «disk full» now beats a disk filled to the last byte;
   * a file system that does not tell its free space is not checked.
   */
  private async checkRoom(
    prepared: Prepared,
    plan: Plan,
    slot: ProjectSlot,
  ): Promise<void> {
    const contents = plan.downloads.reduce((sum, t) => sum + (t.size ?? 0), 0)
    if (!contents) return
    const copies = slot.copies
      ? plan.downloads.reduce(
          (sum, t) => sum + (t.size ?? 0) * t.names.length,
          0,
        ) + plan.links.reduce((sum, l) => sum + (l.size ?? 0), 0)
      : 0
    const needed = contents + copies
    const free = await freeSpace(prepared.folder)
    if (free !== undefined && free > 0 && free < needed) {
      throw new JobError(
        'disk_full',
        'Not enough free space',
        `${needed} bytes needed, ${free} free`,
      )
    }
  }

  /** The user confirmed the removals above the threshold */
  private async runCleanup(job: Job): Promise<SyncResult> {
    const slot = this.slot(job.project.id)
    const started_at = this.iso()
    const prepared = await this.prepare(job)
    try {
      const last = await this.listing(job, slot, false, true)
      const plan = await this.compare(job, slot, prepared, last)
      if (plan.downloads.length) {
        // Removals will go with the next «Scarica»: the confirmation stays
        return this.resultOf('cleanup', started_at, slot, 'completed')
      }
      const executed = await this.execute(job, slot, prepared, plan, true)
      slot.cleanup_confirmed = false
      if (job.controller.signal.aborted)
        return this.stopped(job, slot, prepared, last, started_at)
      slot.runtime.plan = this.summaryAfter(plan, executed, slot)
      return this.resultOf('cleanup', started_at, slot, 'completed')
    } finally {
      await this.release(prepared)
    }
  }

  /* ------------------------------------------------------------------ requests */

  /**
   * The names of the last listing; after a restart, of the listing cache on
   * disk, resolved once and kept (with 100k+ files that takes seconds)
   */
  private async resolvedOf(
    project: EngineProject,
    slot: ProjectSlot,
  ): Promise<ResolvedNames | undefined> {
    if (slot.last?.token == project.token) return slot.last.resolved
    if (slot.saved?.token == project.token) return slot.saved.resolved
    const cache_file = this.cacheFile(project.id)
    const cache = cache_file ? await readIndexCache(cache_file) : undefined
    if (!cache) return undefined
    slot.saved = { token: project.token, resolved: resolveNames(cache) }
    return slot.saved.resolved
  }

  private async schemaOf(
    project: EngineProject,
    slot: ProjectSlot,
  ): Promise<Schema> {
    if (slot.last?.token == project.token) return slot.last.listing.schema
    if (slot.schema?.token != project.token)
      slot.schema = {
        token: project.token,
        schema: await loadSchema(project.token, this.onPageContext()),
      }
    return slot.schema.schema
  }

  private failedPage(project_id: ProjectId, page: Partial<PageQuery>): FailedPage {
    const entries = this.slots.get(project_id)?.failed.list() ?? []
    const offset = Math.max(0, page.offset ?? 0)
    return {
      total: entries.length,
      entries: entries.slice(offset, offset + Math.max(1, page.limit ?? 50)),
    }
  }

  /** A page of the names with different files, searched by name; labels only for that page */
  private async duplicates(
    project: EngineProject,
    page: Partial<PageQuery>,
  ): Promise<DuplicatePage> {
    const slot = this.slot(project.id)
    const resolved = await this.resolvedOf(project, slot)
    if (!resolved?.duplicates.length)
      return { total: 0, language_variants: 0, groups: [] }
    const query = page.query?.trim().normalize('NFC').toLowerCase()
    const matching = query
      ? resolved.duplicates.filter(group => group.key.includes(query))
      : resolved.duplicates
    const offset = Math.max(0, page.offset ?? 0)
    const groups = matching.slice(offset, offset + Math.max(1, page.limit ?? 50))
    const total = {
      total: matching.length,
      language_variants: languageVariants(resolved),
    }
    if (!groups.length) return { ...total, groups: [] }
    const schema = await this.schemaOf(project, slot)
    const lang = schema.lang ?? schema.default_lang

    // Thing labels, read only for the things involved
    const labels = new Map<number, string>()
    const by_resource = new Map<number, Set<number>>()
    for (const group of groups) {
      for (const variant of group.variants) {
        for (const use of variant.uses.slice(0, 20)) {
          let ids = by_resource.get(use.resource_id)
          if (!ids) by_resource.set(use.resource_id, (ids = new Set()))
          ids.add(use.thing_id)
        }
      }
    }
    for (const [resource_id, ids] of by_resource) {
      const resource = schema.resource(resource_id)
      const label_field = resource?.fields.find(f => f.is_textual)
      if (!resource || !label_field) continue
      const all = Array.from(ids)
      for (let i = 0; i < all.length; i += 1000) {
        try {
          const things = await resource
            .query()
            .setFields([label_field.name])
            .where('_id', 'in', all.slice(i, i + 1000))
            .all()
          for (const thing of things) {
            const value = thing.val(label_field)
            if (value !== undefined && value !== null)
              labels.set(Number(thing.id), String(value))
          }
        } catch (error) {
          this.log('warn', `Labels not read: ${errorDetail(error)}`, project.id)
        }
      }
    }

    const label = (get: () => string | undefined, fallback: string): string => {
      try {
        return get() || fallback
      } catch {
        return fallback
      }
    }
    return {
      ...total,
      groups: groups.map(group => ({
      name: group.name,
      variants: group.variants.map(variant => {
        const file = new OpFile(
          { token: variant.token, name: variant.remote_name },
          schema.api as never,
        )
        return {
          token: variant.token,
          size: variant.size,
          width: variant.width,
          height: variant.height,
          thumb_url: file.isImage()
            ? file.link({ x: 100, y: 100, mode: 'contain' })
            : undefined,
          chosen: variant.chosen,
          uses: variant.uses.slice(0, 20).map(use => {
            const resource = schema.resource(use.resource_id)
            const field = schema.field(use.field_id)
            return {
              resource_label: label(
                () => resource?.getLabel(lang),
                String(use.resource_id),
              ),
              field_label: label(
                () => field?.getLabel(lang),
                String(use.field_id),
              ),
              thing_id: use.thing_id,
              thing_label: labels.get(use.thing_id),
              lang: use.lang ?? undefined,
              edit_url: thingEditUrl(
                schema.id,
                use.resource_id,
                use.thing_id,
                use.field_id,
              ),
            }
          }),
        }
      }),
      })),
    }
  }

  /** Removes what the app downloaded: the manifest's names and data/; the folder only if left empty */
  private async deleteProjectFiles(
    project: EngineProject,
  ): Promise<DeleteFilesResult> {
    const slot = this.slots.get(project.id)
    if (slot?.job) {
      slot.job.controller.abort()
      await slot.job.done
    }
    const folder = normalize(project.folder)
    const data_dir = path.join(folder, DATA_DIR)
    const result: DeleteFilesResult = {
      removed_files: 0,
      removed_folder: false,
      kept_entries: 0,
    }
    if (!(await pathExists(folder))) return result
    /** A data/ folder the app did not create is left as it is, and so is everything else */
    if ((await dataDirOwner(data_dir).catch(() => 'foreign')) == 'ours') {
      const lock = await FolderLock.acquire(data_dir, {
        instance_id: this.init?.instance_id ?? 'engine',
        project_id: project.id,
      })
      try {
        const { manifest } = await Manifest.load(data_dir, project.id)
        const scan = await scanFolder(folder)
        await runQueue(manifest.entries(), 8, async ([name]) => {
          const entry = scan.entries.get(nameKey(name))
          if (entry && entry.name == name && entry.type == 'file') {
            if (await unlinkQuiet(path.join(folder, name)).catch(() => false))
              result.removed_files++
          }
        })
        for (const leftover of scan.folder_leftovers)
          await unlinkQuiet(path.join(folder, leftover)).catch(() => undefined)
      } finally {
        await lock.release()
      }
      await removeOwnDataEntries(data_dir)
    }
    const left = await fs.readdir(folder).catch(() => [] as string[])
    result.kept_entries = left.length
    if (!left.length) {
      await fs.rmdir(folder).then(
        () => (result.removed_folder = true),
        () => undefined,
      )
    }
    const cache_file = this.cacheFile(project.id)
    if (cache_file) await unlinkQuiet(cache_file).catch(() => undefined)
    await this.forget(project.id)
    return result
  }
}

const LANGUAGE_VARIANTS = new WeakMap<ResolvedNames, number>()

/**
 * Names whose files are one field of one item in different languages (a
 * datasheet translated under the same name): counted once per listing.
 */
function languageVariants(resolved: ResolvedNames): number {
  let count = LANGUAGE_VARIANTS.get(resolved)
  if (count !== undefined) return count
  count = 0
  for (const group of resolved.duplicates) {
    const at = new Map<string, { variant: number; lang: string | null }[]>()
    let found = false
    group.variants.forEach((variant, index) => {
      for (const use of variant.uses) {
        if (found) return
        const where = `${use.resource_id}:${use.thing_id}:${use.field_id}`
        const others = at.get(where) ?? []
        if (others.some(o => o.variant != index && o.lang != use.lang)) found = true
        others.push({ variant: index, lang: use.lang })
        at.set(where, others)
      }
    })
    if (found) count++
  }
  LANGUAGE_VARIANTS.set(resolved, count)
  return count
}
