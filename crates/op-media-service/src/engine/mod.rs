//! The engine: one job at a time per project, projects side by side, on the
//! service's own runtime. The flows are in `sync::flows`, the folder work in
//! `folder::session`, what the user of the service sees in `state`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::http::{API_RETRY, DOWNLOAD_RETRY, RetryPolicy};
use crate::models::*;

/// What the service tells its user. `State` is throttled (at most every
/// `state_interval` per project, a new phase at once), `Activity` comes in
/// batches while a job runs, `Result` once a job ended (after its last state).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
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

/// The service. Cheap to clone: every clone is the same engine
#[derive(Clone)]
pub struct MediaService {
    inner: Arc<()>,
}

impl MediaService {
    /// Starts the engine on a runtime of its own
    pub fn new(_config: ServiceConfig, _sink: EventSink) -> std::io::Result<MediaService> {
        todo!()
    }

    /// New concurrency (1..10) and/or project folders
    pub fn configure(&self, _concurrency: Option<u32>, _project_folders: Option<Vec<ProjectFolder>>) {
        todo!()
    }

    /// «Sincronizza»: list (incremental when possible), scan, plan. When
    /// nothing needs downloading, links and removals within the safety
    /// threshold are applied at once and the job ends as a completed sync.
    pub fn sync(&self, _project: ServiceProject, _full_listing: bool) {
        todo!()
    }

    /// «Scarica»: execute the plan (re-planning first when it is stale)
    pub fn download(&self, _project: ServiceProject) {
        todo!()
    }

    /// Download again only the files that failed in the last run
    pub fn retry_failed(&self, _project: ServiceProject) {
        todo!()
    }

    /// Apply the removals above the safety threshold the user confirmed
    pub fn confirm_cleanup(&self, _project: ServiceProject) {
        todo!()
    }

    /// The user's stop: what is in flight aborts, what is done stays
    pub fn stop(&self, _project_id: &str) {
        todo!()
    }

    /// The project was removed or its token/folder changed: nothing more is
    /// sent about it, its plans and caches in memory go once its job ended
    pub fn forget(&self, _project_id: &str) {
        todo!()
    }

    /// Kind, space, hard links, problems of a folder; never creates anything
    pub async fn inspect_folder(&self, _path: String, _project_id: Option<ProjectId>) -> FolderInfo {
        todo!()
    }

    /// The user is waiting in a form: two quick attempts
    pub async fn verify_token(&self, _token: String) -> TokenCheck {
        todo!()
    }

    /// The last events of a project (at most 1,000), oldest first
    pub fn activity(&self, _project_id: &str, _limit: Option<usize>) -> Vec<ActivityEntry> {
        todo!()
    }

    /// A page of the files that failed in the last run
    pub fn failed(&self, _project_id: &str, _page: &PageQuery) -> FailedPage {
        todo!()
    }

    /// A page of the duplicate names; thing labels are read for that page only.
    /// Errors are codes (`code` or `code: detail`)
    pub async fn duplicates(&self, _project: ServiceProject, _page: PageQuery) -> Result<DuplicatePage, String> {
        todo!()
    }

    /// Removes data/, the names in the manifest and the folder when left
    /// empty. Refused while a job of the project runs (`project_busy`)
    pub async fn delete_project_files(&self, _project: ServiceProject) -> Result<DeleteFilesResult, String> {
        todo!()
    }

    /// A job of the project runs (or its files are being deleted)
    pub fn is_busy(&self, _project_id: &str) -> bool {
        todo!()
    }

    /// Waits for every running job and deletion to end
    pub async fn idle(&self) {
        todo!()
    }
}
