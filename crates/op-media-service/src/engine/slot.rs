//! A job of a project, and the slot that keeps a project between jobs: its
//! activity, its failed files, and what the user of the service sees of it
//! (the runtime: phase, plan, progress, issues), sent at most every
//! `state_interval` (a new phase at once), the activity in batches while a
//! job runs. The counts of the plan's issues (duplicates, conflicts, removals
//! to confirm) are read from the plan itself, so the two never disagree.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::runtime::Handle;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::{EventSink, ServiceEvent};
use crate::error::{Error, JobError, Result};
use crate::models::*;
use crate::sync::activity::{ActivityLog, FailedList};
use crate::sync::progress::ProgressTracker;

/// Two signals end a job early: the user's stop, and the job's own failure
/// (a fatal error, the loss of the folder lock). Everything in flight
/// listens to `signal`, which fires on both.
pub struct Job {
    pub kind: JobKind,
    pub project: ServiceProject,
    pub started_at: IsoDate,
    signal: CancellationToken,
    stopped: AtomicBool,
    failure: Mutex<Option<JobError>>,
    /// The job's On Page project, once the folder's registry on the disk names it
    pub folder_project: Mutex<Option<OnPageProject>>,
}

impl Job {
    pub fn new(kind: JobKind, project: ServiceProject) -> Job {
        Job {
            kind,
            project,
            started_at: now_iso(),
            signal: CancellationToken::new(),
            stopped: AtomicBool::new(false),
            failure: Mutex::new(None),
            folder_project: Mutex::new(None),
        }
    }

    pub fn signal(&self) -> &CancellationToken {
        &self.signal
    }

    /// The user's stop: what is in flight aborts, what is done stays
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.signal.cancel();
    }

    pub fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Ends the job with this error (the first one counts): what is in flight aborts
    pub fn fail(&self, error: JobError) {
        let mut failure = self.failure.lock();
        if failure.is_none() {
            *failure = Some(error);
        }
        drop(failure);
        self.signal.cancel();
    }

    /// The error that ended the job early
    pub fn failure(&self) -> Option<JobError> {
        self.failure.lock().clone()
    }

    /// Fails when the job is over: its failure, or `Aborted` after a stop
    pub fn check(&self) -> Result<()> {
        if let Some(failure) = self.failure() {
            return Err(Error::Job(failure));
        }
        if self.stopped() {
            return Err(Error::Aborted);
        }
        Ok(())
    }
}

#[derive(Default)]
struct View {
    runtime: ProjectRuntime,
    /// The problem that ended the last job
    job_issues: Vec<Issue>,
    /// On Page asked to slow down during this job
    rate_limited: bool,
    /// The folder copies instead of linking
    copies: bool,
    /// The collections the last listing could not read (until a complete one)
    incomplete: Option<String>,
    closed: bool,
    last_sent: Option<Instant>,
    /// A delayed send is waiting
    timer: bool,
    batches: Option<JoinHandle<()>>,
}

/// What the service keeps about a project between jobs
pub struct Slot {
    pub id: ProjectId,
    pub activity: Mutex<ActivityLog>,
    pub failed: Mutex<FailedList>,
    progress: Mutex<Option<Arc<ProgressTracker>>>,
    view: Mutex<View>,
    pub job: Mutex<Option<Arc<Job>>>,
    /// delete_project_files is emptying the folder: no job starts meanwhile
    pub deleting: AtomicBool,
    /// The removals the last plan held back, as the user saw them: what «Conferma» covers
    pub withheld: Mutex<Vec<String>>,
    /// Notified when a job or a deletion ends
    pub done: Notify,
    /// A job has ended and its result is being sent
    pub ending: AtomicBool,
    /// Bumped by every send: a delayed send of an older state gives way
    sends: AtomicU64,
    sink: EventSink,
    handle: Handle,
    state_interval: Duration,
    activity_interval: Duration,
}

impl Slot {
    pub fn new(
        id: &str,
        sink: EventSink,
        handle: Handle,
        state_interval: Duration,
        activity_interval: Duration,
    ) -> Slot {
        Slot {
            id: id.to_string(),
            activity: Mutex::new(ActivityLog::new()),
            failed: Mutex::new(FailedList::default()),
            progress: Mutex::new(None),
            view: Mutex::new(View::default()),
            job: Mutex::new(None),
            deleting: AtomicBool::new(false),
            withheld: Mutex::new(Vec::new()),
            done: Notify::new(),
            ending: AtomicBool::new(false),
            sends: AtomicU64::new(0),
            sink,
            handle,
            state_interval,
            activity_interval,
        }
    }

    /// A job runs, or the files are being deleted
    pub fn busy(&self) -> bool {
        self.job.lock().is_some() || self.deleting.load(Ordering::SeqCst)
    }

    pub fn current_job(&self) -> Option<Arc<Job>> {
        self.job.lock().clone()
    }

    /// Until no job runs and no deletion
    pub async fn wait_idle(&self) {
        loop {
            let notified = self.done.notified();
            if !self.busy() && !self.ending.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }

    pub fn closed(&self) -> bool {
        self.view.lock().closed
    }

    /// Forgotten: nothing more is sent
    pub fn close(&self) {
        let mut view = self.view.lock();
        view.closed = true;
        if let Some(batches) = view.batches.take() {
            batches.abort();
        }
    }

    pub fn progress(&self) -> Option<Arc<ProgressTracker>> {
        self.progress.lock().clone()
    }

    pub fn set_progress(&self, tracker: ProgressTracker) -> Arc<ProgressTracker> {
        let tracker = Arc::new(tracker);
        *self.progress.lock() = Some(tracker.clone());
        tracker
    }

    pub fn set_rate_limited(&self) {
        self.view.lock().rate_limited = true;
    }

    pub fn set_copies(&self, copies: bool) {
        self.view.lock().copies = copies;
    }

    pub fn copies(&self) -> bool {
        self.view.lock().copies
    }

    pub fn set_incomplete(&self, incomplete: Option<String>) {
        self.view.lock().incomplete = incomplete;
    }

    pub fn set_job_issues(&self, issues: Vec<Issue>) {
        self.view.lock().job_issues = issues;
    }

    pub fn plan(&self) -> Option<PlanSummary> {
        self.view.lock().runtime.plan.clone()
    }

    /// A job starts: no issue of the last job, activity in batches
    pub fn begin(self: &Arc<Self>, kind: JobKind) {
        {
            let mut view = self.view.lock();
            view.job_issues.clear();
            view.rate_limited = false;
            view.runtime.job = Some(kind);
            let slot = Arc::downgrade(self);
            let every = self.activity_interval;
            if let Some(old) = view.batches.replace(self.handle.spawn(async move {
                let mut ticker = tokio::time::interval(every);
                loop {
                    ticker.tick().await;
                    let Some(slot) = slot.upgrade() else { return };
                    slot.flush_activity();
                }
            })) {
                old.abort();
            }
        }
        self.set_phase(JobPhase::Preparing);
    }

    /// The job ended: the last activity, the final state, then the result
    pub fn end(self: &Arc<Self>, result: SyncResult) {
        {
            let mut view = self.view.lock();
            if let Some(batches) = view.batches.take() {
                batches.abort();
            }
        }
        self.flush_activity();
        *self.progress.lock() = None;
        let closed = {
            let mut view = self.view.lock();
            view.rate_limited = false;
            view.runtime.job = None;
            view.runtime.last_result = Some(result.clone());
            view.runtime.phase = JobPhase::Idle;
            view.closed
        };
        self.emit(true);
        if !closed {
            (self.sink)(ServiceEvent::Result { project_id: self.id.clone(), result });
        }
    }

    /// «Interruzione» stays until the job ends
    pub fn set_phase(self: &Arc<Self>, phase: JobPhase) {
        {
            let mut view = self.view.lock();
            if view.runtime.phase == JobPhase::Stopping && phase != JobPhase::Idle {
                return;
            }
            view.runtime.phase = phase;
        }
        self.emit(true);
    }

    pub fn set_plan(&self, mut summary: PlanSummary) {
        summary.created_at = now_iso();
        self.view.lock().runtime.plan = Some(summary);
    }

    /// Throttled; `force` sends now (a new phase, the end of a job)
    pub fn emit(self: &Arc<Self>, force: bool) {
        let wait = {
            let mut view = self.view.lock();
            if view.closed {
                return;
            }
            let since = view.last_sent.map(|t| t.elapsed()).unwrap_or(Duration::MAX);
            if force || since >= self.state_interval {
                None
            } else if view.timer {
                return;
            } else {
                view.timer = true;
                Some(self.state_interval - since)
            }
        };
        match wait {
            None => self.send(),
            Some(wait) => {
                let slot = Arc::downgrade(self);
                let generation = self.sends.load(Ordering::SeqCst);
                self.handle.spawn(async move {
                    tokio::time::sleep(wait).await;
                    let Some(slot) = slot.upgrade() else { return };
                    // A send meanwhile took this one's place
                    if slot.sends.load(Ordering::SeqCst) == generation {
                        slot.send();
                    } else {
                        slot.view.lock().timer = false;
                    }
                });
            }
        }
    }

    pub fn flush_activity(&self) {
        if self.closed() {
            return;
        }
        let entries = self.activity.lock().take_changed();
        if !entries.is_empty() {
            (self.sink)(ServiceEvent::Activity { project_id: self.id.clone(), entries });
        }
    }

    fn send(&self) {
        self.sends.fetch_add(1, Ordering::SeqCst);
        let progress = self.progress().map(|p| p.snapshot());
        let failed = self.failed.lock().retryable_count() as u64;
        let runtime = {
            let mut view = self.view.lock();
            view.timer = false;
            // A timer armed before the project was forgotten
            if view.closed {
                return;
            }
            view.last_sent = Some(Instant::now());
            view.runtime.issues = issues(&view, failed);
            view.runtime.progress = progress;
            view.runtime.clone()
        };
        (self.sink)(ServiceEvent::State { project_id: self.id.clone(), runtime });
    }
}

fn issues(view: &View, failed: u64) -> Vec<Issue> {
    let at = now_iso();
    let mut out = view.job_issues.clone();
    let mut warn = |code: IssueCode, count: Option<u64>, detail: Option<String>| {
        out.push(Issue { code, severity: Severity::Warning, count, detail, at: at.clone() });
    };
    let plan = view.runtime.plan.as_ref();
    if view.rate_limited && view.runtime.job.is_some() {
        warn(IssueCode::RateLimited, None, None);
    }
    if let Some(plan) = plan.filter(|p| p.cleanup_needs_confirmation) {
        warn(IssueCode::CleanupNeedsConfirmation, Some(plan.to_remove), None);
    }
    if let Some(incomplete) = &view.incomplete {
        warn(IssueCode::ListingIncomplete, None, Some(incomplete.clone()));
    }
    if failed > 0 {
        warn(IssueCode::FailedFiles, Some(failed), None);
    }
    if let Some(plan) = plan.filter(|p| p.duplicates > 0) {
        warn(IssueCode::Duplicates, Some(plan.duplicates), None);
    }
    if let Some(plan) = plan.filter(|p| p.conflicts > 0) {
        warn(IssueCode::NameConflicts, Some(plan.conflicts), None);
    }
    if view.copies {
        warn(IssueCode::CopiesInsteadOfLinks, None, None);
    }
    out
}
