//! Executes a plan: renames and links first (fast, no network), then the
//! downloads (one per token, then linked to all its names), then removals.
//! Per-file failures are recorded and the run goes on; disk full, a folder
//! that disappears or becomes read-only end the run: the job fails at once
//! (`fail`), so the transfers in flight stop too, and nothing more is placed
//! or checkpointed. The same once the folder lock is lost (`guard`).

use std::path::Path;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use super::activity::{ActivityLog, ActivityPatch, FailedList, NewActivity};
use super::plan::{DownloadTask, LinkTask, Plan};
use super::progress::{Counter, ProgressTracker};
use super::queue::run_queue;
use crate::error::{Error, FOLDER_GONE_CODES, JobError, NOT_WRITABLE_CODES, Result};
use crate::folder::link::{PlaceMode, Place, place_name, probe_hard_links, remove_name, rename_name};
use crate::folder::manifest::{Manifest, ManifestEntry, ManifestMode};
use crate::fsx::{can_write, free_space, reachable};
use crate::http::{RetryPolicy, with_retry};
use crate::models::{ActivityOutcome, FailedEntry, FailureCode, IssueCode, LogLevel, now_iso};
use crate::transfer::{Download, download_to_file};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// Renames and links
    Links,
    Downloads,
    Removals,
}

pub struct ExecuteContext<'a> {
    pub folder: &'a Path,
    pub data_dir: &'a Path,
    pub manifest: &'a Manifest,
    pub plan: &'a Plan,
    pub http: &'a reqwest::Client,
    /// The storage URL of a token under its On Page name
    pub storage_url: &'a (dyn Fn(&str, &str) -> String + Send + Sync),
    pub concurrency: usize,
    pub cancel: &'a CancellationToken,
    pub progress: &'a ProgressTracker,
    pub activity: &'a Mutex<ActivityLog>,
    pub failed: &'a Mutex<FailedList>,
    /// Links or copies when known; probed before the first name is placed otherwise
    pub hardlinks: Option<bool>,
    pub policy: RetryPolicy,
    pub headers_timeout: Duration,
    pub idle_timeout: Duration,
    pub on_change: &'a (dyn Fn() + Send + Sync),
    pub on_stage: &'a (dyn Fn(Stage) + Send + Sync),
    pub on_rate_limited: &'a (dyn Fn(Duration) + Send + Sync),
    /// What the probe of hard links found, as soon as it ran
    pub on_probe: &'a (dyn Fn(bool) + Send + Sync),
    pub log: &'a (dyn Fn(LogLevel, String) + Send + Sync),
    /// Fails when the folder is not the job's to write any more: its lock went to another computer
    pub guard: &'a (dyn Fn() -> Result<()> + Send + Sync),
    /// Ends the job with a fatal error: `cancel` fires, the transfers in flight abort
    pub fail: &'a (dyn Fn(JobError) + Send + Sync),
    /// How long a folder may take to answer before it counts as gone
    pub reach_timeout: Duration,
}

#[derive(Debug, Clone, Default)]
pub struct ExecuteResult {
    pub downloaded: u64,
    pub linked: u64,
    pub removed: u64,
    pub failed: u64,
    pub conflicts: u64,
    pub copies: u64,
    pub bytes: u64,
    /// What the probe found, when it ran
    pub hardlinks: Option<bool>,
}

#[derive(Default)]
struct Counts {
    downloaded: AtomicU64,
    linked: AtomicU64,
    removed: AtomicU64,
    failed: AtomicU64,
    conflicts: AtomicU64,
    copies: AtomicU64,
    bytes: AtomicU64,
}

/// A disk with less than this left is full, whatever it said
const FULL_MARGIN: u64 = 16 * 1024 * 1024;

/// A name that could not be placed: the reasons the user can act on stay, the rest is a link error
fn link_failure(reason: FailureCode) -> FailureCode {
    match reason {
        FailureCode::InUse | FailureCode::FileTooLarge => reason,
        _ => FailureCode::LinkError,
    }
}

struct Run<'a> {
    ctx: &'a ExecuteContext<'a>,
    counts: Counts,
    hardlinks: Option<bool>,
    fatal: Mutex<Option<JobError>>,
}

impl<'a> Run<'a> {
    fn changed(&self) {
        (self.ctx.on_change)()
    }

    fn add(&self, entry: NewActivity) -> u64 {
        self.ctx.activity.lock().add(entry)
    }

    fn update(&self, id: u64, patch: ActivityPatch) {
        self.ctx.activity.lock().update(id, patch)
    }

    fn record(&self, name: &str, token: &str, reason: FailureCode, detail: Option<String>, size: Option<u64>, attempts: u32) {
        self.ctx.failed.lock().set(FailedEntry {
            name: name.to_string(),
            token: token.to_string(),
            size,
            reason,
            detail,
            attempts,
            at: now_iso(),
        });
        if reason == FailureCode::NameConflict {
            self.counts.conflicts.fetch_add(1, Ordering::Relaxed);
        } else {
            self.counts.failed.fetch_add(1, Ordering::Relaxed);
            self.ctx.progress.count(Counter::Failed, 1);
        }
    }

    fn fatal(&self) -> Option<JobError> {
        self.fatal.lock().clone()
    }

    /// Before each write: none once the run failed or the folder went to another computer
    fn guard(&self) -> Result<()> {
        if let Some(fatal) = self.fatal() {
            return Err(Error::Job(fatal));
        }
        (self.ctx.guard)()
    }

    /// The manifest now and then, under the same guard
    async fn checkpoint(&self) {
        if self.guard().is_ok() {
            let _ = self.ctx.manifest.checkpoint().await;
        }
    }

    /// Turns a file system error into the end of the run when it is not about
    /// one file: the disk is full, the folder is gone (a share, an unplugged
    /// disk) or read-only. ENOSPC with plenty of room left is a limit on one
    /// file (4 GB on FAT32): that file fails, the run goes on.
    async fn fatal_error(&self, error: &Error, size: Option<u64>) -> Option<JobError> {
        if let Error::Job(job) = error {
            return Some(job.clone());
        }
        let code = error.code()?;
        let detail = error.detail();
        if code == "EDQUOT" {
            return Some(JobError::with_detail(IssueCode::DiskFull, "The quota is used up", detail));
        }
        if code == "ENOSPC" {
            let free = free_space(self.ctx.folder).await;
            return match free {
                Some(free) if free > size.unwrap_or(0) + FULL_MARGIN => None,
                _ => Some(JobError::with_detail(IssueCode::DiskFull, "The disk is full", detail)),
            };
        }
        if FOLDER_GONE_CODES.contains(&code)
            && !reachable(self.ctx.data_dir, self.ctx.reach_timeout, Some(self.ctx.cancel)).await.unwrap_or(true)
        {
            return Some(JobError::with_detail(IssueCode::FolderUnreachable, "The folder cannot be reached", detail));
        }
        if NOT_WRITABLE_CODES.contains(&code) && !can_write(self.ctx.data_dir).await {
            return Some(JobError::with_detail(IssueCode::FolderNotWritable, "The folder is read-only", detail));
        }
        None
    }

    /// Every error of a worker goes through here: fatal ones end the run (decided once).
    /// None: stopped, nothing to record
    async fn handle(&self, error: &Error, size: Option<u64>) -> Result<Option<FailureCode>> {
        if error.is_aborted() || self.ctx.cancel.is_cancelled() {
            return Ok(None);
        }
        if let Some(fatal) = self.fatal() {
            return Err(Error::Job(fatal));
        }
        let end = self.fatal_error(error, size).await;
        if self.ctx.cancel.is_cancelled() {
            return Ok(None);
        }
        if let Some(fatal) = self.fatal() {
            return Err(Error::Job(fatal));
        }
        if let Some(end) = end {
            *self.fatal.lock() = Some(end.clone());
            // The other workers' transfers stop now, not when they end
            (self.ctx.fail)(end.clone());
            return Err(Error::Job(end));
        }
        Ok(Some(if error.code() == Some("ENOSPC") { FailureCode::FileTooLarge } else { error.failure_code() }))
    }

    async fn place(&self, task: &LinkTask) -> Result<PlaceMode> {
        self.guard()?;
        let mode = place_name(Place {
            folder: self.ctx.folder,
            data_dir: self.ctx.data_dir,
            name: &task.target.name,
            token: &task.token,
            replace: task.target.replace.as_deref(),
            hardlinks: self.hardlinks,
        })
        .await?;
        if mode == PlaceMode::Copy {
            self.counts.copies.fetch_add(1, Ordering::Relaxed);
        }
        self.ctx.manifest.set(
            &task.target.name,
            ManifestEntry {
                token: task.token.clone(),
                size: task.target.size,
                mode: if mode == PlaceMode::Link { ManifestMode::Link } else { ManifestMode::Copy },
                remote_name: Some(task.target.remote_name.clone()),
            },
        );
        self.ctx.failed.lock().delete(&task.target.name);
        Ok(mode)
    }

    fn conflict(&self, name: &str, token: &str, size: Option<u64>) {
        self.add(NewActivity::new(name, token, size, ActivityOutcome::Conflict).reason(FailureCode::NameConflict));
        self.record(name, token, FailureCode::NameConflict, None, size, 1);
    }

    async fn rename(&self, task: &super::plan::RenameTask) -> Result<()> {
        let done: Result<()> = async {
            self.guard()?;
            rename_name(self.ctx.folder, &task.from, &task.to).await?;
            self.ctx.manifest.set(&task.to, task.entry.clone());
            Ok(())
        }
        .await;
        match done {
            Ok(()) => {
                self.counts.linked.fetch_add(1, Ordering::Relaxed);
                self.ctx.progress.count(Counter::Linked, 1);
                self.add(NewActivity::new(&task.to, &task.token, task.entry.size, ActivityOutcome::Linked).same_as(&task.from));
            }
            Err(error) => {
                if let Some(reason) = self.handle(&error, task.entry.size).await? {
                    self.record(&task.to, &task.token, link_failure(reason), Some(error.detail()), task.entry.size, 1);
                }
            }
        }
        self.checkpoint().await;
        self.changed();
        Ok(())
    }

    async fn link(&self, task: &LinkTask) -> Result<()> {
        let name = &task.target.name;
        match self.place(task).await {
            Ok(_) => {
                self.counts.linked.fetch_add(1, Ordering::Relaxed);
                self.ctx.progress.count(Counter::Linked, 1);
                self.add(NewActivity::new(name, &task.token, task.target.size, ActivityOutcome::Linked));
            }
            Err(Error::Conflict(_)) => self.conflict(name, &task.token, task.target.size),
            Err(error) => {
                if let Some(reason) = self.handle(&error, task.target.size).await? {
                    let code = link_failure(reason);
                    self.add(NewActivity::new(name, &task.token, task.target.size, ActivityOutcome::Failed).reason(code));
                    self.record(name, &task.token, code, Some(error.detail()), task.target.size, 1);
                }
            }
        }
        self.checkpoint().await;
        self.changed();
        Ok(())
    }

    async fn download(&self, task: &DownloadTask) -> Result<()> {
        self.guard()?;
        let ctx = self.ctx;
        let first = &task.names[0];
        let entry = self.add(NewActivity::new(&first.name, &task.token, task.size, ActivityOutcome::Downloading).progress(0.0));
        ctx.progress.in_flight(1);
        self.changed();
        let attempt_bytes = AtomicI64::new(0);
        let attempts = AtomicU32::new(0);
        let known_size = Mutex::new(task.size);
        let url = (ctx.storage_url)(&task.token, &first.remote_name);
        let target = ctx.data_dir.join(&task.token);
        let on_bytes = |delta: u64| {
            let done = attempt_bytes.fetch_add(delta as i64, Ordering::Relaxed) + delta as i64;
            ctx.progress.add_bytes(delta as i64);
            if let Some(size) = *known_size.lock() {
                if size > 0 {
                    let ratio = (done as f64 / size as f64).min(1.0);
                    self.update(entry, ActivityPatch { progress: Some(Some(ratio)), ..Default::default() });
                }
            }
        };
        let on_length = |length: u64| {
            let mut known = known_size.lock();
            if known.is_none() {
                *known = Some(length);
                ctx.progress.add_bytes_total(length);
            }
        };
        let downloaded = with_retry(
            &ctx.policy,
            Some(ctx.cancel),
            |error, attempt, delay| {
                ctx.progress.add_bytes(-attempt_bytes.swap(0, Ordering::Relaxed));
                self.update(entry, ActivityPatch { progress: Some(Some(0.0)), ..Default::default() });
                if matches!(error, Error::Http { status: 429, .. }) {
                    (ctx.on_rate_limited)(delay);
                }
                (ctx.log)(LogLevel::Debug, format!("Retry {attempt} for {} in {} ms: {}", task.token, delay.as_millis(), error.detail()));
                self.changed();
            },
            |_| {
                attempts.fetch_add(1, Ordering::Relaxed);
                download_to_file(Download {
                    http: ctx.http,
                    url: &url,
                    target: &target,
                    expected_size: task.size,
                    cancel: Some(ctx.cancel),
                    headers_timeout: ctx.headers_timeout,
                    idle_timeout: ctx.idle_timeout,
                    on_bytes: &on_bytes,
                    on_length: &on_length,
                })
            },
        )
        .await;
        let bytes = match downloaded {
            Ok(bytes) => bytes,
            Err(error) => {
                ctx.progress.add_bytes(-attempt_bytes.load(Ordering::Relaxed));
                ctx.progress.in_flight(-1);
                if error.is_aborted() || ctx.cancel.is_cancelled() {
                    self.update(
                        entry,
                        ActivityPatch {
                            outcome: Some(ActivityOutcome::Failed),
                            reason: Some(FailureCode::Aborted),
                            progress: Some(None),
                            ..Default::default()
                        },
                    );
                    self.changed();
                    return Ok(());
                }
                let Some(reason) = self.handle(&error, task.size).await? else { return Ok(()) };
                self.update(
                    entry,
                    ActivityPatch { outcome: Some(ActivityOutcome::Failed), reason: Some(reason), progress: Some(None), ..Default::default() },
                );
                let attempts = attempts.load(Ordering::Relaxed);
                for target in &task.names {
                    self.record(&target.name, &task.token, reason, Some(error.detail()), task.size, attempts);
                }
                self.changed();
                return Ok(());
            }
        };
        self.counts.bytes.fetch_add(bytes, Ordering::Relaxed);
        ctx.progress.in_flight(-1);

        // The content is in data/: put it under every name
        let mut placed_first = false;
        let mut stopped = false;
        for target in &task.names {
            let link = LinkTask { target: target.clone(), token: task.token.clone() };
            match self.place(&link).await {
                Ok(_) => {
                    self.counts.downloaded.fetch_add(1, Ordering::Relaxed);
                    ctx.progress.count(Counter::Downloaded, 1);
                    if !placed_first {
                        placed_first = true;
                        self.update(
                            entry,
                            ActivityPatch {
                                outcome: Some(ActivityOutcome::Downloaded),
                                progress: Some(None),
                                name: Some(target.name.clone()),
                                ..Default::default()
                            },
                        );
                    } else {
                        self.add(NewActivity::new(&target.name, &task.token, task.size, ActivityOutcome::Linked).same_as(&first.name));
                    }
                }
                Err(Error::Conflict(_)) => self.conflict(&target.name, &task.token, task.size),
                Err(error) => {
                    let Some(reason) = self.handle(&error, task.size).await? else {
                        // Stopped, or the job is over: no more names
                        stopped = true;
                        break;
                    };
                    let code = link_failure(reason);
                    self.add(NewActivity::new(&target.name, &task.token, task.size, ActivityOutcome::Failed).reason(code));
                    self.record(&target.name, &task.token, code, Some(error.detail()), task.size, 1);
                }
            }
        }
        if !placed_first {
            self.update(
                entry,
                ActivityPatch {
                    outcome: Some(ActivityOutcome::Failed),
                    reason: Some(if stopped { FailureCode::Aborted } else { FailureCode::LinkError }),
                    progress: Some(None),
                    ..Default::default()
                },
            );
        }
        self.checkpoint().await;
        self.changed();
        Ok(())
    }

    async fn remove(&self, name: &str) -> Result<()> {
        let entry = self.ctx.manifest.get(name);
        let size = entry.as_ref().and_then(|e| e.size);
        let token = entry.as_ref().map(|e| e.token.clone());
        let done: Result<()> = async {
            self.guard()?;
            remove_name(self.ctx.folder, name).await?;
            self.ctx.manifest.delete(name);
            Ok(())
        }
        .await;
        match done {
            Ok(()) => {
                self.counts.removed.fetch_add(1, Ordering::Relaxed);
                self.ctx.progress.count(Counter::Removed, 1);
                self.add(NewActivity { token, ..NewActivity::new(name, "", size, ActivityOutcome::Removed) });
            }
            Err(error) => {
                // Not removed: it stays in the manifest and the next run tries again
                if let Some(reason) = self.handle(&error, size).await? {
                    let reason = if reason == FailureCode::InUse { reason } else { FailureCode::WriteError };
                    self.add(NewActivity { token, ..NewActivity::new(name, "", size, ActivityOutcome::Failed).reason(reason) });
                    (self.ctx.log)(LogLevel::Warn, format!("Cannot remove {name}: {}", error.detail()));
                }
            }
        }
        self.checkpoint().await;
        self.changed();
        Ok(())
    }

    async fn remove_token(&self, token: &str) -> Result<()> {
        let done: Result<bool> = async {
            self.guard()?;
            remove_name(self.ctx.data_dir, token).await
        }
        .await;
        if let Err(error) = done {
            if self.handle(&error, None).await?.is_some() {
                (self.ctx.log)(LogLevel::Warn, format!("Cannot remove data/{token}: {}", error.detail()));
            }
        }
        Ok(())
    }
}

pub async fn execute_plan(ctx: &ExecuteContext<'_>) -> Result<ExecuteResult> {
    let plan = ctx.plan;
    let mut run = Run { ctx, counts: Counts::default(), hardlinks: ctx.hardlinks, fatal: Mutex::new(None) };
    let fs_lanes = (ctx.concurrency * 2).clamp(4, 16);

    // Manifest-only changes: no disk work
    for name in &plan.drop_entries {
        ctx.manifest.delete(name);
    }
    for adoption in &plan.adoptions {
        ctx.manifest.set(
            &adoption.name,
            ManifestEntry {
                token: adoption.token.clone(),
                size: adoption.size,
                mode: adoption.mode,
                remote_name: Some(adoption.remote_name.clone()),
            },
        );
    }
    ctx.progress.count(Counter::AlreadyPresent, plan.up_to_date);

    // Conflicts are reported, never touched
    for conflict in &plan.conflicts {
        run.conflict(&conflict.name, &conflict.token, conflict.size);
    }
    run.changed();

    // Links or copies, decided once for the whole job
    let mut probed = None;
    if run.hardlinks.is_none() && (!plan.links.is_empty() || !plan.downloads.is_empty()) {
        probed = probe_hard_links(ctx.data_dir).await;
        run.hardlinks = probed;
        if let Some(hardlinks) = probed {
            (ctx.on_probe)(hardlinks);
        }
        if probed == Some(false) {
            (ctx.log)(LogLevel::Info, "The folder does not take hard links: names are copies".into());
        }
    }
    let run = &run;

    let work: Result<()> = async {
        // 1. Case changes
        (ctx.on_stage)(Stage::Links);
        run_queue(&plan.renames, fs_lanes, Some(ctx.cancel), |task, _| run.rename(task)).await?;
        // 2. Names of contents already in data/
        run_queue(&plan.links, fs_lanes, Some(ctx.cancel), |task, _| run.link(task)).await?;
        // 3. Downloads
        if !plan.downloads.is_empty() {
            (ctx.on_stage)(Stage::Downloads);
        }
        run_queue(&plan.downloads, ctx.concurrency.max(1), Some(ctx.cancel), |task, _| run.download(task)).await?;
        // 4. Removals
        if !ctx.cancel.is_cancelled() {
            if !plan.remove_names.is_empty() || !plan.remove_tokens.is_empty() {
                (ctx.on_stage)(Stage::Removals);
            }
            run_queue(&plan.remove_names, fs_lanes, Some(ctx.cancel), |name, _| run.remove(name)).await?;
            run_queue(&plan.remove_tokens, fs_lanes, Some(ctx.cancel), |token, _| run.remove_token(token)).await?;
        }
        Ok(())
    }
    .await;
    if let Err(error) = work {
        return Err(match run.fatal() {
            Some(fatal) => Error::Job(fatal),
            None => error,
        });
    }
    let c = &run.counts;
    Ok(ExecuteResult {
        downloaded: c.downloaded.load(Ordering::Relaxed),
        linked: c.linked.load(Ordering::Relaxed),
        removed: c.removed.load(Ordering::Relaxed),
        failed: c.failed.load(Ordering::Relaxed),
        conflicts: c.conflicts.load(Ordering::Relaxed),
        copies: c.copies.load(Ordering::Relaxed),
        bytes: c.bytes.load(Ordering::Relaxed),
        hardlinks: probed,
    })
}
