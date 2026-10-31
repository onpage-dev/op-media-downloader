/**
 * The steps the flows share: the folder session around a job, the listing,
 * the plan, the execution, and the results.
 */
import { Issue, SyncResult } from '../../shared/models'
import { AbortedError, errorDetail, folderJobError, HttpError, JobError } from '../errors'
import { executePlan, ExecuteResult } from '../executor'
import { FolderSession } from '../folder-session'
import { JobContext } from '../job'
import { LinkCapability } from '../link'
import { failedLabels, listRemote } from '../listing'
import { Listed } from '../listing-store'
import { resolveNames } from '../names'
import { storageLinker } from '../onpage'
import { Plan, summaryLeft } from '../plan'
import { ProgressTracker } from '../progress'

/** Opens the folder for the job, works, frees the folder whatever happened */
export async function inFolder<T>(ctx: JobContext, work: (session: FolderSession) => Promise<T>): Promise<T> {
  const { engine, job } = ctx
  const session = await FolderSession.open(job, {
    project_folders: engine.projectFolders(),
    instance_id: engine.instanceId(),
    reach_timeout_ms: engine.timings.reach_timeout_ms,
    lock_stale_ms: engine.timings.lock_stale_ms,
    lock_heartbeat_ms: engine.timings.lock_heartbeat_ms,
    log: (level, message) => engine.log(level, message, job.project.id),
  })
  try {
    return await work(session)
  } finally {
    await session.close()
  }
}

/** The listing: reused from memory when fresh, otherwise incremental from the cache */
export async function list(ctx: JobContext, options: { full: boolean; reuse: boolean }): Promise<Listed> {
  const { engine, slot, job } = ctx
  const { id, token } = job.project
  if (options.reuse) {
    const fresh = engine.listings.fresh(id, token)
    if (fresh) return fresh
  }
  slot.state.setPhase('listing')
  engine.listings.begin(id)
  try {
    const cache = options.full ? undefined : await engine.listings.readCache(id)
    slot.state.progress = new ProgressTracker(
      { total: 0, bytes_total: 0, concurrency: engine.concurrency() },
      engine.now,
    )
    const listing = await listRemote({
      token,
      ctx: engine.onPageContext(job.signal, (error, _attempt, delay) => {
        if (error instanceof HttpError && error.status == 429) {
          slot.state.rate_limited = true
          engine.log('info', `On Page asked to slow down: waiting ${Math.round(delay / 1000)} s`, id)
        }
        slot.state.emit()
      }),
      cache,
      full: options.full,
      page_size: engine.timings.page_size,
      parallel: engine.timings.parallel_pages,
      signal: job.signal,
      now: engine.now,
      onProgress: progress => {
        if (slot.state.progress) slot.state.progress.progress.listing = progress
        slot.state.emit()
      },
      log: (level, message) => engine.log(level, message, id),
    })
    if (listing.complete) {
      await engine.listings
        .writeCache(id, listing.index)
        .catch(error => engine.log('warn', `Listing cache not written: ${errorDetail(error)}`, id))
    }
    for (const failed of listing.failed_resources)
      engine.log('warn', `Collection ${failed.label} not read: ${failed.error}`, id)
    // Until a complete listing: what was not read keeps what the cache knew, nothing is removed
    slot.state.incomplete = listing.complete ? undefined : failedLabels(listing.failed_resources)
    const resolved = resolveNames(listing.index)
    for (const entry of slot.failed.list()) if (entry.reason == 'invalid_name') slot.failed.delete(entry.name)
    for (const bad of resolved.invalid) {
      slot.failed.set({
        name: bad.remote_name,
        token: bad.token,
        reason: 'invalid_name',
        attempts: 0,
        at: new Date(engine.now()).toISOString(),
      })
    }
    return engine.listings.keep(id, { token, listing, resolved })
  } finally {
    engine.listings.end(id)
  }
}

/**
 * Scan and plan. What the plan holds back is what the user sees, and what a
 * confirmation will cover; `confirmed` lets the names of one through.
 */
export async function compare(
  ctx: JobContext,
  session: FolderSession,
  listed: Listed,
  confirmed?: ReadonlySet<string>,
): Promise<Plan> {
  const { slot, job } = ctx
  slot.state.setPhase('comparing')
  const plan = await session.plan(
    {
      desired: listed.resolved.desired,
      keep_old_files: job.project.keep_old_files,
      listing_complete: listed.listing.complete,
      listing: listed.listing.mode,
      duplicates: listed.resolved.duplicates.length,
      confirmed,
    },
    job.signal,
  )
  slot.withheld = plan.withheld
  slot.state.setPlan(plan.summary)
  return plan
}

/**
 * Executes (a part of) a plan; the manifest is saved at the end whatever
 * ended the run, unless the lock is lost. `reset_failed`: this run decides
 * again what failed (a download, or a sync that applies everything); a sync
 * that only does bookkeeping keeps the failures of the last download for the
 * «Falliti» tab.
 */
export async function execute(
  ctx: JobContext,
  session: FolderSession,
  plan: Plan,
  reset_failed: boolean,
): Promise<ExecuteResult> {
  const { engine, slot, job } = ctx
  const total =
    plan.renames.length +
    plan.links.length +
    plan.downloads.reduce((sum, t) => sum + t.names.length, 0) +
    plan.remove_names.length
  const bytes_total = plan.downloads.reduce((sum, t) => sum + (t.size ?? 0), 0)
  slot.state.progress = new ProgressTracker({ total, bytes_total, concurrency: engine.concurrency() }, engine.now)
  if (reset_failed) {
    for (const entry of slot.failed.list()) if (entry.reason != 'invalid_name') slot.failed.delete(entry.name)
  }
  slot.state.setPhase('finishing')
  const capability: LinkCapability = {}
  const run = await executePlan({
    folder: session.folder,
    data_dir: session.data_dir,
    manifest: session.manifest,
    plan,
    fetch: engine.fetch,
    storageUrl: storageLinker(engine.apiDomain()),
    concurrency: engine.concurrency(),
    signal: job.signal,
    progress: slot.state.progress,
    activity: slot.activity,
    failed: slot.failed,
    capability,
    policy: engine.timings.download_policy,
    headers_timeout_ms: engine.timings.headers_timeout_ms,
    idle_timeout_ms: engine.timings.idle_timeout_ms,
    onChange: () => slot.state.emit(),
    onStage: stage => slot.state.setPhase(stage == 'downloads' ? 'downloading' : 'finishing'),
    onRateLimited: () => {
      slot.state.rate_limited = true
      slot.state.emit()
    },
    log: (level, message) => engine.log(level, message, slot.id),
    guard: () => session.guard(),
    fail: error => job.fail(error),
    reach_timeout_ms: engine.timings.reach_timeout_ms,
  }).then(
    result => ({ result }),
    (error: unknown) => ({ error }),
  )
  // A copy for a content with too many names says nothing about the folder
  if (capability.hardlinks !== undefined) slot.state.copies = !capability.hardlinks
  // What was placed is registered, whatever ended the run
  const save_error = await session.save()
  if (save_error) engine.log('error', `data/manifest.json not written: ${errorDetail(save_error)}`, slot.id)
  if ('error' in run) throw run.error
  // The lock lost while the last transfers ended: the run failed all the same
  if (job.failure) throw job.failure
  // The files are in place but not registered: the run must not look complete
  if (save_error) throw folderJobError(save_error) ?? save_error
  return run.result
}

/**
 * After a stop: what is left of the plan becomes the plan of the next
 * «Scarica», from the manifest the run kept, without scanning the folder again
 */
export function stopped(ctx: JobContext, plan: Plan, session: FolderSession, executed: ExecuteResult): SyncResult {
  ctx.slot.state.setPlan(summaryLeft(plan, session.manifest, executed.conflicts))
  return resultOf(ctx, 'stopped')
}

export function resultOf(ctx: JobContext, outcome: SyncResult['outcome']): SyncResult {
  const { slot, job } = ctx
  const p = slot.state.progress?.progress
  return {
    job: job.kind,
    started_at: job.started_at,
    ended_at: new Date(ctx.engine.now()).toISOString(),
    outcome,
    total: slot.state.runtime.plan?.remote_names ?? p?.total ?? 0,
    downloaded: p?.downloaded ?? 0,
    linked: p?.linked ?? 0,
    removed: p?.removed ?? 0,
    already_present: p?.already_present ?? 0,
    failed: p?.failed ?? 0,
    bytes: p?.bytes_done ?? 0,
  }
}

/** A job that threw: stopped by the user, or failed with the issue to show */
export function resultOfError(ctx: JobContext, error: unknown): SyncResult {
  const { engine, slot, job } = ctx
  // The job's own failure (a lost lock, a fatal error) says why, whatever was thrown after it
  const failure = job.failure
  const user_stop = !failure && (error instanceof AbortedError || job.stopped)
  const total = slot.state.progress?.progress.total ?? 0
  if (user_stop) return { ...resultOf(ctx, 'stopped'), total }
  const job_error =
    failure ?? folderJobError(error) ?? new JobError('unexpected', 'Unexpected error', errorDetail(error))
  if (!failure && !(error instanceof JobError))
    engine.log('error', `Job ${job.kind} failed: ${errorDetail(error)}`, slot.id)
  const issue: Issue = {
    code: job_error.issue,
    severity: job_error.issue == 'offline' || job_error.issue == 'rate_limited' ? 'warning' : 'error',
    detail: job_error.detail ?? job_error.message,
    at: new Date(engine.now()).toISOString(),
  }
  slot.state.job_issues = [issue]
  return { ...resultOf(ctx, 'failed'), total, error: issue }
}
