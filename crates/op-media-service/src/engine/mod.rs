//! The engine: one job at a time per project, projects side by side, on the
//! service's own runtime. The flows are in `flows`, the folder work in
//! `session`, what the user of the service sees in `slot`.

mod flows;
mod session;
mod slot;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures::FutureExt;
use parking_lot::Mutex;
use serde::Serialize;
use tokio::runtime::{Handle, Runtime};
use tokio_util::sync::CancellationToken;

use self::flows::{JobContext, result_of_error, run_cleanup, run_download, run_sync};
use self::slot::{Job, Slot};
use crate::error::{Error, Result};
use crate::folder::delete::{DeleteOptions, delete_project_files};
use crate::folder::inspect::{InspectContext, inspect_folder};
use crate::http::{API_RETRY, DOWNLOAD_RETRY, RetryPolicy};
use crate::models::*;
use crate::onpage::{Api, DEFAULT_DOMAIN, OnPageContext, http_client, verify_token};
use crate::sync::duplicates::duplicates_page;
use crate::sync::listing_store::ListingStore;

/// What the service tells its user. `State` is throttled (at most every
/// `state_interval` per project, a new phase at once), `Activity` comes in
/// batches while a job runs, `Result` once a job ended (after its last state).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)] // moved once to the sink, never stored in bulk
pub enum ServiceEvent {
    State { project_id: ProjectId, runtime: ProjectRuntime },
    Activity { project_id: ProjectId, entries: Vec<ActivityEntry> },
    Result { project_id: ProjectId, result: SyncResult },
    Log { level: LogLevel, message: String, project_id: Option<ProjectId> },
}

/// Where the events go: called on the service's threads, it must not block
pub type EventSink = Arc<dyn Fn(ServiceEvent) + Send + Sync + 'static>;

/// The timings and limits of the engine. Tests pass shorter ones
#[derive(Debug, Clone)]
pub struct Timings {
    pub state_interval: Duration,
    pub activity_interval: Duration,
    /// A listing kept in memory is reused by «Scarica» for this long, then dropped
    pub listing_max_age: Duration,
    pub api_policy: RetryPolicy,
    pub download_policy: RetryPolicy,
    /// Per API request, whole answer
    pub api_timeout: Duration,
    /// A download that sends no header for this long is a timeout
    pub headers_timeout: Duration,
    /// A download that sends no byte for this long is a timeout
    pub idle_timeout: Duration,
    pub page_size: usize,
    pub parallel_pages: usize,
    pub lock_stale: Duration,
    pub lock_heartbeat: Duration,
    /// A folder root that does not answer in this time is unreachable
    pub reach_timeout: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Timings {
            state_interval: Duration::from_millis(250),
            activity_interval: Duration::from_millis(250),
            listing_max_age: Duration::from_secs(30 * 60),
            api_policy: API_RETRY,
            download_policy: DOWNLOAD_RETRY,
            api_timeout: Duration::from_secs(120),
            headers_timeout: Duration::from_secs(30),
            idle_timeout: Duration::from_secs(60),
            page_size: crate::sync::listing::PAGE_SIZE,
            parallel_pages: crate::sync::listing::PARALLEL_PAGES,
            lock_stale: crate::folder::lock::LOCK_STALE,
            lock_heartbeat: crate::folder::lock::LOCK_HEARTBEAT,
            reach_timeout: Duration::from_secs(15),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ServiceConfig {
    /// Local folder for the listing caches, one file per project
    pub cache_dir: PathBuf,
    /// Parallel downloads per project, 1..10
    pub concurrency: u32,
    /// For the logs and the folder lock: one per running app
    pub instance_id: String,
    /// Development and tests only: the On Page domain instead of
    /// https://app.onpage.it (e.g. http://127.0.0.1:4310 for the fake server
    /// that answers both the API and the storage links)
    pub api_domain: Option<String>,
    /// Folders of all projects, to detect overlaps
    pub project_folders: Vec<ProjectFolder>,
    pub timings: Timings,
}

/// The engine behind the service: what every job sees
pub(crate) struct Engine {
    pub timings: Timings,
    pub instance_id: String,
    pub api_domain: String,
    pub http: reqwest::Client,
    pub listings: ListingStore,
    settings: Mutex<(u32, Vec<ProjectFolder>)>,
    slots: Mutex<HashMap<ProjectId, Arc<Slot>>>,
    sink: EventSink,
    handle: Handle,
}

impl Engine {
    pub fn log(&self, level: LogLevel, message: String, project_id: Option<&str>) {
        (self.sink)(ServiceEvent::Log { level, message, project_id: project_id.map(str::to_string) });
    }

    /// Parallel downloads, 1..10
    pub fn concurrency(&self) -> usize {
        self.settings.lock().0.clamp(1, 10) as usize
    }

    pub fn project_folders(&self) -> Vec<ProjectFolder> {
        self.settings.lock().1.clone()
    }

    pub fn onpage_context(&self, cancel: Option<CancellationToken>) -> OnPageContext {
        OnPageContext {
            policy: self.timings.api_policy,
            timeout: self.timings.api_timeout,
            cancel,
            ..OnPageContext::new(self.http.clone(), self.api_domain.clone())
        }
    }

    fn slot(&self, id: &str) -> Arc<Slot> {
        self.slots
            .lock()
            .entry(id.to_string())
            .or_insert_with(|| {
                Arc::new(Slot::new(
                    id,
                    self.sink.clone(),
                    self.handle.clone(),
                    self.timings.state_interval,
                    self.timings.activity_interval,
                ))
            })
            .clone()
    }

    fn existing_slot(&self, id: &str) -> Option<Arc<Slot>> {
        self.slots.lock().get(id).cloned()
    }
}

/// The runtime the service owns, shut down with the last clone
struct OwnedRuntime(Mutex<Option<Runtime>>);

impl Drop for OwnedRuntime {
    fn drop(&mut self) {
        if let Some(runtime) = self.0.lock().take() {
            runtime.shutdown_background();
        }
    }
}

/// The service. Cheap to clone: every clone is the same engine
#[derive(Clone)]
pub struct MediaService {
    engine: Arc<Engine>,
    _runtime: Arc<OwnedRuntime>,
}

type Flow = Box<dyn FnOnce(Arc<JobContext>) -> futures::future::BoxFuture<'static, Result<SyncResult>> + Send>;

impl MediaService {
    /// Starts the engine on a runtime of its own: every file system call on a
    /// share that hangs waits on its blocking pool, never on the caller
    pub fn new(config: ServiceConfig, sink: EventSink) -> std::io::Result<MediaService> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .max_blocking_threads(256)
            .thread_name("op-media-service")
            .enable_all()
            .build()?;
        let handle = runtime.handle().clone();
        Ok(MediaService::build(config, sink, handle, Some(runtime)))
    }

    /// The engine on a runtime of the caller (tests, an app that has one to give)
    pub fn with_handle(config: ServiceConfig, sink: EventSink, handle: Handle) -> MediaService {
        MediaService::build(config, sink, handle, None)
    }

    fn build(config: ServiceConfig, sink: EventSink, handle: Handle, runtime: Option<Runtime>) -> MediaService {
        let api_domain = config.api_domain.clone().unwrap_or_else(|| DEFAULT_DOMAIN.to_string());
        let engine = Engine {
            listings: ListingStore::new(config.cache_dir.clone(), config.timings.listing_max_age),
            http: http_client(concat!("OnPageMediaService/", env!("CARGO_PKG_VERSION"))),
            timings: config.timings,
            instance_id: config.instance_id,
            api_domain,
            settings: Mutex::new((config.concurrency, config.project_folders)),
            slots: Mutex::new(HashMap::new()),
            sink,
            handle,
        };
        MediaService { engine: Arc::new(engine), _runtime: Arc::new(OwnedRuntime(Mutex::new(runtime))) }
    }

    /// New concurrency (1..10) and/or project folders
    pub fn configure(&self, concurrency: Option<u32>, project_folders: Option<Vec<ProjectFolder>>) {
        let mut settings = self.engine.settings.lock();
        if let Some(concurrency) = concurrency.filter(|c| *c > 0) {
            settings.0 = concurrency;
        }
        if let Some(folders) = project_folders {
            settings.1 = folders;
        }
    }

    /// «Sincronizza»: list (incremental when possible), scan, plan. When
    /// nothing needs downloading, links and removals within the safety
    /// threshold are applied at once and the job ends as a completed sync.
    pub fn sync(&self, project: ServiceProject, full_listing: bool) {
        self.start(project, JobKind::Sync, Box::new(move |ctx| run_sync(ctx, full_listing).boxed()));
    }

    /// «Scarica»: execute the plan (re-planning first when it is stale)
    pub fn download(&self, project: ServiceProject) {
        self.start(project, JobKind::Download, Box::new(|ctx| run_download(ctx, false).boxed()));
    }

    /// Download again only the files that failed in the last run
    pub fn retry_failed(&self, project: ServiceProject) {
        self.start(project, JobKind::RetryFailed, Box::new(|ctx| run_download(ctx, true).boxed()));
    }

    /// Apply the removals above the safety threshold the user confirmed: the
    /// ones the last plan held back, and only those
    pub fn confirm_cleanup(&self, project: ServiceProject) {
        let confirmed: HashSet<String> = self
            .engine
            .existing_slot(&project.id)
            .map(|s| s.withheld.lock().iter().cloned().collect())
            .unwrap_or_default();
        self.start(project, JobKind::Cleanup, Box::new(move |ctx| run_cleanup(ctx, confirmed).boxed()));
    }

    fn start(&self, project: ServiceProject, kind: JobKind, flow: Flow) {
        let engine = &self.engine;
        let slot = engine.slot(&project.id);
        let job = {
            let mut current = slot.job.lock();
            let why = if let Some(running) = current.as_ref() {
                Some(format!("a {} job is already running", running.kind.as_str()))
            } else if slot.deleting.load(Ordering::SeqCst) {
                Some("its files are being deleted".to_string())
            } else if slot.closed() {
                Some("the project was forgotten".to_string())
            } else {
                None
            };
            if let Some(why) = why {
                let running = current.is_some();
                drop(current);
                engine.log(LogLevel::Warn, format!("{} ignored: {why}", kind.as_str()), Some(&project.id));
                // The user of the service showed the job as starting: the state says it is not
                if !running {
                    slot.emit(true);
                }
                return;
            }
            let job = Arc::new(Job::new(kind, project));
            *current = Some(job.clone());
            job
        };
        slot.begin(kind);
        let ctx = Arc::new(JobContext { engine: engine.clone(), slot, job });
        let handle = engine.handle.clone();
        engine.handle.spawn(async move {
            // A panic of the flow ends the job as an unexpected failure, nothing else
            let result = match handle.spawn(flow(ctx.clone())).await {
                Ok(Ok(result)) => result,
                Ok(Err(error)) => result_of_error(&ctx, error),
                Err(join) => {
                    let what = if join.is_panic() { panic_text(join.into_panic()) } else { "cancelled".into() };
                    result_of_error(&ctx, Error::Other(format!("The job stopped unexpectedly: {what}")))
                }
            };
            // No job any more when the result goes out: whoever gets it may start the next one
            ctx.slot.ending.store(true, Ordering::SeqCst);
            *ctx.slot.job.lock() = None;
            ctx.slot.end(result);
            ctx.slot.ending.store(false, Ordering::SeqCst);
            ctx.slot.done.notify_waiters();
        });
    }

    /// The user's stop: what is in flight aborts, what is done stays
    pub fn stop(&self, project_id: &str) {
        let Some(slot) = self.engine.existing_slot(project_id) else {
            return;
        };
        let Some(job) = slot.current_job() else {
            return;
        };
        if job.stopped() {
            return;
        }
        job.stop();
        slot.set_phase(JobPhase::Stopping);
    }

    /// The project was removed or its token/folder changed: nothing more is
    /// sent about it, its plans and caches in memory go once its job ended
    pub fn forget(&self, project_id: &str) {
        let engine = self.engine.clone();
        let id = project_id.to_string();
        if let Some(slot) = engine.existing_slot(&id) {
            slot.close();
            if let Some(job) = slot.current_job() {
                job.stop();
            }
        }
        self.engine.handle.spawn(async move { forget(&engine, &id).await });
    }

    /// Kind, space, hard links, problems of a folder; never creates anything
    pub async fn inspect_folder(&self, path: String, project_id: Option<ProjectId>) -> FolderInfo {
        let engine = self.engine.clone();
        let fallback_path = path.clone();
        let task = self.engine.handle.spawn(async move {
            let folders = engine.project_folders();
            inspect_folder(
                &path,
                InspectContext {
                    project_id: project_id.as_ref(),
                    project_folders: &folders,
                    instance_id: Some(&engine.instance_id),
                    reach_timeout: crate::folder::inspect::REACH_TIMEOUT,
                },
            )
            .await
        });
        task.await.unwrap_or_else(|_| FolderInfo {
            path: fallback_path,
            kind: DestinationKind::Unknown,
            exists: false,
            writable: false,
            free_bytes: None,
            hardlinks: None,
            foreign_entries: None,
            problems: vec![FolderProblem::Unreachable],
            problem_detail: None,
            onpage_project: None,
            inspected_at: now_iso(),
        })
    }

    /// The user is waiting in a form: two quick attempts, no long backoff
    pub async fn verify_token(&self, token: String) -> TokenCheck {
        let engine = self.engine.clone();
        let task = self.engine.handle.spawn(async move {
            let mut ctx = engine.onpage_context(None);
            ctx.policy =
                RetryPolicy { attempts: 2, max_retry_after: Duration::from_secs(5), ..engine.timings.api_policy };
            ctx.timeout = Duration::from_secs(20);
            verify_token(&token, ctx).await
        });
        task.await.unwrap_or(TokenCheck {
            ok: false,
            error: Some(TokenError::ProjectUnavailable),
            ..TokenCheck::default()
        })
    }

    /// The last events of a project (at most 1,000), oldest first
    pub fn activity(&self, project_id: &str, limit: Option<usize>) -> Vec<ActivityEntry> {
        self.engine
            .existing_slot(project_id)
            .map(|s| s.activity.lock().recent(limit.unwrap_or(1000)))
            .unwrap_or_default()
    }

    /// A page of the files that failed in the last run
    pub fn failed(&self, project_id: &str, page: &PageQuery) -> FailedPage {
        let entries = self.engine.existing_slot(project_id).map(|s| s.failed.lock().list()).unwrap_or_default();
        FailedPage {
            total: entries.len() as u64,
            entries: entries.into_iter().skip(page.offset).take(page.limit.max(1)).collect(),
        }
    }

    /// A page of the duplicate names; thing labels are read for that page only.
    /// Errors are codes (`code` or `code: detail`)
    pub async fn duplicates(&self, project: ServiceProject, page: PageQuery) -> Result<DuplicatePage, String> {
        let engine = self.engine.clone();
        let task = self.engine.handle.spawn(async move {
            // No slot for a project the service does not run: the store keeps the names for a while
            let (id, token) = (project.id.as_str(), project.token.as_str());
            let resolved = engine.listings.resolved(id, token).await;
            let load = async {
                let schema = engine
                    .listings
                    .schema(id, token, || async { Api::new(token, engine.onpage_context(None)).load_schema().await })
                    .await?;
                let api = Api::for_schema(token, engine.onpage_context(None), &schema);
                Ok((schema, api))
            };
            duplicates_page(resolved.as_deref(), &page, load, &engine.api_domain, |message| {
                engine.log(LogLevel::Warn, message, Some(id))
            })
            .await
        });
        match task.await {
            Ok(Ok(page)) => Ok(page),
            Ok(Err(error)) => Err(error_code(&error)),
            Err(_) => Err("unexpected".into()),
        }
    }

    /// Removes data/, the names in the manifest and the folder when left
    /// empty. Refused while a job of the project runs (`project_busy`); no
    /// job starts while it runs. The cache and the memory of the project go
    /// with its files.
    pub async fn delete_project_files(&self, project: ServiceProject) -> Result<DeleteFilesResult, String> {
        let engine = self.engine.clone();
        let slot = engine.slot(&project.id);
        {
            let job = slot.job.lock();
            if job.is_some() || slot.deleting.swap(true, Ordering::SeqCst) {
                return Err("project_busy".into());
            }
        }
        let task = self.engine.handle.spawn({
            let engine = engine.clone();
            let project = project.clone();
            async move {
                let options = DeleteOptions {
                    instance_id: engine.instance_id.clone(),
                    lock_stale: engine.timings.lock_stale,
                    lock_heartbeat: engine.timings.lock_heartbeat,
                };
                delete_project_files(&project, &options).await
            }
        });
        let result = task.await;
        slot.deleting.store(false, Ordering::SeqCst);
        slot.done.notify_waiters();
        let result = match result {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => return Err(error_code(&error)),
            Err(_) => return Err("unexpected".into()),
        };
        let id = project.id.clone();
        let cleanup = self.engine.handle.spawn(async move {
            engine.listings.remove_cache(&id).await;
            if let Some(slot) = engine.existing_slot(&id) {
                slot.close();
            }
            forget(&engine, &id).await;
        });
        let _ = cleanup.await;
        Ok(result)
    }

    /// A job of the project runs (or its files are being deleted)
    pub fn is_busy(&self, project_id: &str) -> bool {
        self.engine.existing_slot(project_id).is_some_and(|s| s.busy())
    }

    /// Waits for every running job and deletion to end
    pub async fn idle(&self) {
        let slots: Vec<Arc<Slot>> = self.engine.slots.lock().values().cloned().collect();
        for slot in slots {
            slot.wait_idle().await;
        }
    }
}

/// The slot stays while its job ends, so no new job takes the folder meanwhile
async fn forget(engine: &Arc<Engine>, id: &str) {
    if let Some(slot) = engine.existing_slot(id) {
        slot.wait_idle().await;
        let mut slots = engine.slots.lock();
        if slots.get(id).is_some_and(|s| Arc::ptr_eq(s, &slot)) {
            slots.remove(id);
        }
    }
    // After the job: a listing that ended meanwhile kept its names
    engine.listings.forget(id);
}

/// What a request answers when it fails: the issue's code, or the error's
fn error_code(error: &Error) -> String {
    match error {
        Error::Job(job) => match &job.detail {
            Some(detail) => format!("{}: {detail}", job.issue),
            None => job.issue.to_string(),
        },
        Error::Other(message) if message.starts_with("folder_other_project") => message.clone(),
        other => other.detail(),
    }
}

fn panic_text(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic".into())
}
