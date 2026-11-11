//! The flows of a job and the steps they share: the folder session around a
//! job, the listing, the plan, the execution, and the results.
//!
//! - «Sincronizza» (`run_sync`): list (incremental when possible), compare;
//!   when nothing needs downloading, the links and the removals within the
//!   threshold are applied at once and the job ends as a completed sync.
//! - «Scarica» and «Riprova i falliti» (`run_download`): the listing of the
//!   last «Sincronizza» when it is fresh (a new one otherwise), a new compare,
//!   then the whole plan, or only the names that failed.
//! - «Conferma» (`run_cleanup`): the removals the plan held back when the
//!   user saw it, and only those; downloads and links wait for «Scarica».

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::Engine;
use super::session::{FolderSession, PlanRequest, SessionOptions};
use super::slot::{Job, Slot};
use crate::error::{Error, JobError, Result};
use crate::models::*;
use crate::onpage::storage_link;
use crate::sync::executor::{ExecuteContext, ExecuteResult, Stage, execute_plan};
use crate::sync::listing::{ListingOptions, MARGIN, MAX_CACHE_AGE, failed_labels, list_remote};
use crate::sync::listing_store::Listed;
use crate::sync::names::resolve_names;
use crate::sync::plan::{Plan, bookkeeping, only_names, removals_only, summary_after, summary_left};
use crate::sync::progress::ProgressTracker;

/// What a flow works with
pub struct JobContext {
    pub engine: Arc<Engine>,
    pub slot: Arc<Slot>,
    pub job: Arc<Job>,
}

impl JobContext {
    fn log(&self, level: LogLevel, message: String) {
        self.engine.log(level, message, Some(&self.slot.id));
    }
}

/// Opens the folder for the job; the flow frees it whatever happened
async fn open_folder(ctx: &JobContext) -> Result<FolderSession> {
    let log = |level: LogLevel, message: String| ctx.log(level, message);
    let timings = &ctx.engine.timings;
    FolderSession::open(
        &ctx.job,
        SessionOptions {
            project_folders: ctx.engine.project_folders(),
            instance_id: ctx.engine.instance_id.clone(),
            reach_timeout: timings.reach_timeout,
            lock_stale: timings.lock_stale,
            lock_heartbeat: timings.lock_heartbeat,
            log: &log,
            registries: &ctx.engine.registries,
        },
    )
    .await
}

/// The listing: reused from memory when fresh, otherwise incremental from the cache
async fn list(ctx: &JobContext, full: bool, reuse: bool) -> Result<Listed> {
    let engine = &ctx.engine;
    let (id, token) = (&ctx.job.project.id, &ctx.job.project.token);
    if reuse && let Some(fresh) = engine.listings.fresh(id, token) {
        return Ok(fresh);
    }
    ctx.slot.set_phase(JobPhase::Listing);
    // The names of the listing this one replaces: the same, when nothing changed on On Page
    let previous_names = engine.listings.kept_names(id, token);
    engine.listings.begin(id);
    let listed = async {
        let started = Instant::now();
        let cache = if full { None } else { engine.listings.read_cache(id).await };
        let cache_read = started.elapsed();
        let tracker = ctx.slot.set_progress(ProgressTracker::new(0, 0, engine.concurrency() as u64));
        let slot = ctx.slot.clone();
        let on_retry_engine = engine.clone();
        let on_retry_id = id.clone();
        let mut api_ctx = engine.onpage_context(Some(ctx.job.signal().clone()));
        api_ctx.on_retry = Some(Arc::new(move |error: &Error, _attempt: u32, delay: Duration| {
            if matches!(error, Error::Http { status: 429, .. }) {
                slot.set_rate_limited();
                on_retry_engine.log(
                    LogLevel::Info,
                    format!("On Page asked to slow down: waiting {} s", delay.as_secs()),
                    Some(&on_retry_id),
                );
            }
            slot.emit(false);
        }));
        let on_progress = |progress: ListingProgress| {
            tracker.set_listing(progress);
            ctx.slot.emit(false);
        };
        let log = |level: LogLevel, message: String| ctx.log(level, message);
        let listing = list_remote(ListingOptions {
            token,
            ctx: api_ctx,
            cache,
            full,
            page_size: engine.timings.page_size,
            parallel: engine.timings.parallel_pages,
            max_cache_age: MAX_CACHE_AGE,
            margin: MARGIN,
            cancel: Some(ctx.job.signal().clone()),
            on_progress: &on_progress,
            log: &log,
        })
        .await?;
        let listed_in = started.elapsed();
        let local = Instant::now();
        let resolved = match previous_names.filter(|_| !listing.changed) {
            Some(names) => names,
            None => {
                let index = listing.index.clone();
                Arc::new(
                    tokio::task::spawn_blocking(move || resolve_names(&index))
                        .await
                        .map_err(|e| Error::Other(e.to_string()))?,
                )
            }
        };
        let names_resolved = local.elapsed();
        for failed in &listing.failed_resources {
            ctx.log(LogLevel::Warn, format!("Collection {} not read: {}", failed.label, failed.error));
        }
        // Until a complete listing: what was not read keeps what the cache knew, nothing is removed
        ctx.slot.set_incomplete((!listing.complete).then(|| failed_labels(&listing.failed_resources)));
        {
            let mut failed = ctx.slot.failed.lock();
            failed.retain(|e| e.reason != FailureCode::InvalidName);
            for bad in &resolved.invalid {
                failed.set(FailedEntry {
                    name: bad.remote_name.clone(),
                    token: bad.token.clone(),
                    size: None,
                    reason: FailureCode::InvalidName,
                    detail: None,
                    attempts: 0,
                    at: now_iso(),
                });
            }
        }
        ctx.log(
            LogLevel::Info,
            format!(
                "Listing ({:?}{}): {} files in {:.1?} (cache read {:.1?}); names {:.1?}",
                listing.mode,
                if listing.changed { "" } else { ", unchanged" },
                listing.index.file_count(),
                listed_in,
                cache_read,
                names_resolved
            ),
        );
        let (complete, changed) = (listing.complete, listing.changed);
        let listed = engine.listings.keep(id, token, listing, resolved);
        // The caches for the next listing and the next start, in the background: nobody waits for them
        if complete {
            let duplicates = (Arc::new(listed.listing.schema.clone()), listed.resolved.clone());
            let (log_engine, log_id) = (engine.clone(), id.clone());
            engine
                .listings
                .save_in_background(id, listed.listing.index.clone(), duplicates, changed, move |message| {
                    log_engine.log(LogLevel::Warn, message, Some(&log_id))
                })
                .await;
        }
        Ok(listed)
    }
    .await;
    engine.listings.end(id);
    listed
}

/// Scan and plan. What the plan holds back is what the user sees, and what
/// a confirmation will cover; `confirmed` lets the names of one through.
async fn compare(
    ctx: &JobContext,
    session: &FolderSession,
    listed: &Listed,
    confirmed: Option<&HashSet<String>>,
) -> Result<Plan> {
    let schema = &listed.listing.schema;
    // Before anything is linked or removed: the folder must be this On Page project's
    session.bind(&OnPageProject { id: schema.id, label: schema.label.clone() }, ctx.job.project.take_over_folder)?;
    ctx.slot.set_phase(JobPhase::Comparing);
    let log = |level: LogLevel, message: String| ctx.log(level, message);
    let plan = session
        .plan(
            PlanRequest {
                resolved: listed.resolved.clone(),
                keep_old_files: ctx.job.project.keep_old_files,
                listing_complete: listed.listing.complete,
                listing: listed.listing.mode,
                confirmed: confirmed.cloned(),
                duplicates: listed.resolved.duplicates.len() as u64,
            },
            &ctx.job,
            &log,
        )
        .await?;
    *ctx.slot.withheld.lock() = plan.withheld.clone();
    ctx.slot.set_plan(plan.summary.clone());
    Ok(plan)
}

/// Executes (a part of) a plan; the manifest is saved at the end whatever
/// ended the run, unless the lock is lost. `reset_failed`: this run decides
/// again what failed (a download, or a sync that applies everything); a sync
/// that only does bookkeeping keeps the failures of the last download.
async fn execute(ctx: &JobContext, session: &FolderSession, plan: &Plan, reset_failed: bool) -> Result<ExecuteResult> {
    let engine = &ctx.engine;
    let slot = &ctx.slot;
    let total = plan.renames.len()
        + plan.links.len()
        + plan.downloads.iter().map(|t| t.names.len()).sum::<usize>()
        + plan.remove_names.len();
    let bytes_total: u64 = plan.downloads.iter().map(|t| t.size.unwrap_or(0)).sum();
    let concurrency = engine.concurrency();
    let progress = slot.set_progress(ProgressTracker::new(total as u64, bytes_total, concurrency as u64));
    if reset_failed {
        slot.failed.lock().retain(|e| e.reason == FailureCode::InvalidName);
    }
    slot.set_phase(JobPhase::Finishing);
    let domain = engine.api_domain.clone();
    let storage_url = move |token: &str, name: &str| storage_link(&domain, token, name);
    let on_change = || slot.emit(false);
    let on_stage = |stage: Stage| {
        slot.set_phase(if stage == Stage::Downloads { JobPhase::Downloading } else { JobPhase::Finishing })
    };
    let on_rate_limited = |_delay: Duration| {
        slot.set_rate_limited();
        slot.emit(false);
    };
    // A copy for a content with too many names says nothing about the folder
    let on_probe = |hardlinks: bool| slot.set_copies(!hardlinks);
    let log = |level: LogLevel, message: String| ctx.log(level, message);
    let guard = || session.guard();
    let fail = |error: JobError| ctx.job.fail(error);
    let started = Instant::now();
    let run = execute_plan(&ExecuteContext {
        folder: &session.folder,
        data_dir: &session.data_dir,
        manifest: &session.manifest,
        plan,
        http: &engine.http,
        storage_url: &storage_url,
        concurrency,
        cancel: ctx.job.signal(),
        progress: &progress,
        activity: &slot.activity,
        failed: &slot.failed,
        hardlinks: None,
        policy: engine.timings.download_policy,
        headers_timeout: engine.timings.headers_timeout,
        idle_timeout: engine.timings.idle_timeout,
        on_change: &on_change,
        on_stage: &on_stage,
        on_rate_limited: &on_rate_limited,
        on_probe: &on_probe,
        log: &log,
        guard: &guard,
        fail: &fail,
        reach_timeout: engine.timings.reach_timeout,
    })
    .await;
    let ran = started.elapsed();
    // What was placed is registered, whatever ended the run
    let save_error = session.save().await;
    if let Ok(result) = &run {
        ctx.log(
            LogLevel::Info,
            format!(
                "Run: {} downloaded, {} linked, {} removed in {ran:.1?}; registry of {} names saved in {:.1?}",
                result.downloaded,
                result.linked,
                result.removed,
                session.manifest.len(),
                started.elapsed() - ran
            ),
        );
    }
    // The registry on the disk names this job's On Page project: the choice of the folder is done
    let (written, bound) = (session.manifest.written_project(), session.manifest.onpage_project());
    if let (Some(written), Some(bound)) = (written, bound)
        && written.id == bound.id
    {
        *ctx.job.folder_project.lock() = Some(written);
    }
    if let Some(error) = &save_error {
        ctx.log(LogLevel::Error, format!("data/manifest.json not written: {}", error.detail()));
    }
    let result = run?;
    // The lock lost while the last transfers ended: the run failed all the same
    if let Some(failure) = ctx.job.failure() {
        return Err(Error::Job(failure));
    }
    // The files are in place but not registered: the run must not look complete
    if let Some(error) = save_error {
        return Err(error.into_job_error());
    }
    Ok(result)
}

/// After a stop: what is left of the plan becomes the plan of the next
/// «Scarica», from the manifest the run kept, without scanning the folder again
fn stopped(ctx: &JobContext, plan: &Plan, session: &FolderSession, executed: &ExecuteResult) -> SyncResult {
    ctx.slot.set_plan(summary_left(plan, &session.manifest, executed.conflicts));
    result_of(ctx, SyncOutcome::Stopped)
}

pub fn result_of(ctx: &JobContext, outcome: SyncOutcome) -> SyncResult {
    let progress = ctx.slot.progress().map(|p| p.current());
    let p = progress.as_ref();
    SyncResult {
        job: ctx.job.kind,
        started_at: ctx.job.started_at.clone(),
        ended_at: now_iso(),
        outcome,
        total: ctx.slot.plan().map(|plan| plan.remote_names).or(p.map(|p| p.total)).unwrap_or(0),
        downloaded: p.map_or(0, |p| p.downloaded),
        linked: p.map_or(0, |p| p.linked),
        removed: p.map_or(0, |p| p.removed),
        already_present: p.map_or(0, |p| p.already_present),
        failed: p.map_or(0, |p| p.failed),
        bytes: p.map_or(0, |p| p.bytes_done),
        error: None,
        onpage_project: ctx.job.folder_project.lock().clone(),
    }
}

/// A job that failed: stopped by the user, or failed with the issue to show
pub fn result_of_error(ctx: &JobContext, error: Error) -> SyncResult {
    // The job's own failure (a lost lock, a fatal error) says why, whatever was returned after it
    let failure = ctx.job.failure();
    let total = ctx.slot.progress().map(|p| p.current().total).unwrap_or(0);
    if failure.is_none() && (error.is_aborted() || ctx.job.stopped()) {
        return SyncResult { total, ..result_of(ctx, SyncOutcome::Stopped) };
    }
    let job_error = failure
        .clone()
        .or_else(|| error.folder_job_error())
        .unwrap_or_else(|| JobError::with_detail(IssueCode::Unexpected, "Unexpected error", error.detail()));
    if failure.is_none() && !matches!(error, Error::Job(_)) {
        ctx.log(LogLevel::Error, format!("Job {} failed: {}", ctx.job.kind.as_str(), error.detail()));
    }
    let issue = Issue {
        code: job_error.issue,
        severity: if matches!(job_error.issue, IssueCode::Offline | IssueCode::RateLimited) {
            Severity::Warning
        } else {
            Severity::Error
        },
        count: None,
        detail: Some(job_error.detail.clone().unwrap_or(job_error.message.clone())),
        at: now_iso(),
    };
    ctx.slot.set_job_issues(vec![issue.clone()]);
    SyncResult { total, error: Some(issue), ..result_of(ctx, SyncOutcome::Failed) }
}

pub async fn run_sync(ctx: Arc<JobContext>, full: bool) -> Result<SyncResult> {
    let ctx = &*ctx;
    let session = open_folder(ctx).await?;
    let result = sync_in(ctx, &session, full).await;
    session.close(&ctx.engine.registries).await;
    result
}

async fn sync_in(ctx: &JobContext, session: &FolderSession, full: bool) -> Result<SyncResult> {
    let listed = list(ctx, full, false).await?;
    let plan = compare(ctx, session, &listed, None).await?;
    if !plan.downloads.is_empty() {
        // Only bookkeeping now (adoptions, forgotten names); the rest waits for «Scarica»
        execute(ctx, session, &bookkeeping(&plan), false).await?;
        return Ok(result_of(ctx, SyncOutcome::Completed));
    }
    let executed = execute(ctx, session, &plan, true).await?;
    if ctx.job.stopped() {
        return Ok(stopped(ctx, &plan, session, &executed));
    }
    ctx.slot.set_plan(summary_after(&plan, executed.linked, executed.downloaded, executed.conflicts));
    Ok(result_of(ctx, SyncOutcome::Completed))
}

pub async fn run_download(ctx: Arc<JobContext>, only_failed: bool) -> Result<SyncResult> {
    let ctx = &*ctx;
    let retry: Option<HashSet<String>> =
        only_failed.then(|| ctx.slot.failed.lock().retryable().into_iter().map(|e| e.name).collect());
    let session = open_folder(ctx).await?;
    let result = download_in(ctx, &session, retry).await;
    session.close(&ctx.engine.registries).await;
    result
}

async fn download_in(ctx: &JobContext, session: &FolderSession, retry: Option<HashSet<String>>) -> Result<SyncResult> {
    let listed = list(ctx, false, true).await?;
    let plan = compare(ctx, session, &listed, None).await?;
    let part = match &retry {
        Some(names) => only_names(&plan, names),
        None => plan.clone(),
    };
    session.check_room(&part, ctx.slot.copies()).await?;
    let executed = execute(ctx, session, &part, retry.is_none()).await?;
    if ctx.job.stopped() {
        return Ok(stopped(ctx, &plan, session, &executed));
    }
    ctx.slot.set_plan(match retry {
        // Other work may still be pending: the rest of the plan says what
        Some(_) => summary_left(&plan, &session.manifest, executed.conflicts),
        None => summary_after(&plan, executed.linked, executed.downloaded, executed.conflicts),
    });
    Ok(result_of(ctx, SyncOutcome::Completed))
}

pub async fn run_cleanup(ctx: Arc<JobContext>, confirmed: HashSet<String>) -> Result<SyncResult> {
    let ctx = &*ctx;
    let session = open_folder(ctx).await?;
    let result = cleanup_in(ctx, &session, &confirmed).await;
    session.close(&ctx.engine.registries).await;
    result
}

async fn cleanup_in(ctx: &JobContext, session: &FolderSession, confirmed: &HashSet<String>) -> Result<SyncResult> {
    let listed = list(ctx, false, true).await?;
    let plan = compare(ctx, session, &listed, Some(confirmed)).await?;
    // Nothing to download: everything goes now, as a «Sincronizza» would do
    let whole = plan.downloads.is_empty();
    let part = if whole { plan.clone() } else { removals_only(&plan) };
    let executed = execute(ctx, session, &part, whole).await?;
    if ctx.job.stopped() {
        return Ok(stopped(ctx, &plan, session, &executed));
    }
    ctx.slot.set_plan(if whole {
        summary_after(&plan, executed.linked, executed.downloaded, executed.conflicts)
    } else {
        summary_left(&plan, &session.manifest, executed.conflicts)
    });
    Ok(result_of(ctx, SyncOutcome::Completed))
}
