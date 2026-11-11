//! Projects as the app sees them: configuration from the store, live runtime
//! from the service, persistence of results and plans, and the operations the
//! page, the tray and the menus ask for. Creating, editing and removing
//! projects run one at a time; a removed project leaves the list at once, its
//! job and the deletion of its files end in the background.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use op_media_service::{
    ActivityEntry, DuplicatePage, DuplicateVariants, FailedPage, FolderInfo, FolderProblem, Issue, IssueCode, JobKind,
    JobPhase, MediaService, PageQuery, ProjectFolder, ProjectId, ProjectRuntime, ServiceEvent, ServiceProject,
    SyncOutcome, SyncResult, TokenCheck, TokenError, VariantsQuery,
};
use parking_lot::Mutex;

use crate::models::*;
use crate::store::{AppStore, StoredProject};
use crate::{error, info, warn};

/// What happened, for the windows, the tray and the notifications
pub enum ProjectsEvent {
    /// Debounced: every change of configuration, runtime or folder info
    Changed(Vec<ProjectView>),
    Activity(ProjectId, Vec<ActivityEntry>),
    Result(Box<ProjectView>, Box<SyncResult>),
    /// A removed project whose files could not be deleted: its label, and the error code
    DeleteFailed {
        label: String,
        code: String,
    },
}

/// Issues that still make sense after a restart
const PERSISTED_ISSUES: &[IssueCode] = &[
    IssueCode::TokenInvalid,
    IssueCode::ProjectUnavailable,
    IssueCode::ListingFailed,
    IssueCode::Unexpected,
    IssueCode::ListingIncomplete,
    IssueCode::FolderUnreachable,
    IssueCode::FolderNotWritable,
    IssueCode::FolderProtected,
    IssueCode::FolderOtherProject,
    IssueCode::DiskFull,
    IssueCode::Duplicates,
    IssueCode::FailedFiles,
    IssueCode::CopiesInsteadOfLinks,
    IssueCode::NameConflicts,
    IssueCode::CleanupNeedsConfirmation,
    IssueCode::Interrupted,
];

/// Folder problems that make a project impossible to save
const BLOCKING_PROBLEMS: &[FolderProblem] =
    &[FolderProblem::Protected, FolderProblem::UsedByOtherProject, FolderProblem::ForeignData];

const AUTO_RETRY_DELAY: Duration = Duration::from_secs(60);
/// How long the job of a removed project gets to stop
const STOP_WAIT: Duration = Duration::from_secs(90);
/// The service answers these while the job still stops: the deletion is tried again
const DELETE_RETRY_ERRORS: &[&str] = &["project_busy"];
const DELETE_ATTEMPTS: u32 = 3;
/// A share that does not answer counts as missing after this
const FOLDER_CHECK: Duration = Duration::from_secs(10);
/// The page hears of the projects at most this often; the first change after a quiet moment at once
const CHANGE_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Default)]
struct State {
    runtimes: HashMap<ProjectId, ProjectRuntime>,
    /// Jobs already retried automatically, so a retry never loops
    auto_retried: HashSet<String>,
    /// Removed projects whose files are being deleted: their folders stay taken meanwhile
    deleting: HashMap<ProjectId, ServiceProject>,
}

pub struct ProjectService {
    store: Arc<AppStore>,
    service: MediaService,
    /// Where the background work runs (the app's runtime, or the command's)
    runtime: tokio::runtime::Handle,
    state: Mutex<State>,
    /// Creating, editing and removing run one at a time: two creates could take the same folder
    edits: tokio::sync::Mutex<()>,
    notify: Box<dyn Fn(ProjectsEvent) + Send + Sync>,
    change_scheduled: AtomicBool,
    /// When the page last heard of the projects
    last_change: Mutex<Option<Instant>>,
    /// Wakes whoever waits for jobs to end
    changes: tokio::sync::Notify,
}

impl ProjectService {
    pub fn new(
        store: Arc<AppStore>,
        service: MediaService,
        runtime: tokio::runtime::Handle,
        notify: impl Fn(ProjectsEvent) + Send + Sync + 'static,
    ) -> Arc<ProjectService> {
        Arc::new(ProjectService {
            store,
            service,
            runtime,
            state: Mutex::new(State::default()),
            edits: tokio::sync::Mutex::new(()),
            notify: Box::new(notify),
            change_scheduled: AtomicBool::new(false),
            last_change: Mutex::new(None),
            changes: tokio::sync::Notify::new(),
        })
    }

    /* ---------------------------------------------------------------- reading */

    pub fn views(&self) -> Vec<ProjectView> {
        self.store.projects().iter().map(|project| self.to_view(project)).collect()
    }

    /// A job runs (also the one of a removed project, while it stops)
    pub fn is_running(&self) -> bool {
        self.state.lock().runtimes.values().any(|runtime| runtime.phase != JobPhase::Idle)
    }

    /// The files of a removed project are being deleted
    pub fn is_deleting(&self) -> bool {
        !self.state.lock().deleting.is_empty()
    }

    pub fn status(&self, online: bool) -> AppStatus {
        let views = self.views();
        AppStatus {
            online,
            running_jobs: views.iter().filter(|v| v.runtime.phase != JobPhase::Idle).count() as u64,
            speed_bps: views.iter().map(|v| v.runtime.progress.as_ref().map_or(0.0, |p| p.speed_bps)).sum(),
            total_files: views
                .iter()
                .map(|v| {
                    v.runtime
                        .plan
                        .as_ref()
                        .map(|p| p.remote_names)
                        .or(v.runtime.last_result.as_ref().map(|r| r.total))
                        .unwrap_or(0)
                })
                .sum(),
            total_bytes: views.iter().map(|v| v.runtime.plan.as_ref().map_or(0, |p| p.remote_bytes)).sum(),
        }
    }

    pub fn reveal_token(&self, id: &str) -> Result<String, String> {
        Ok(self.store.token(&self.require(id)?))
    }

    /// The folder of a project as recorded here, when it is there: the page never names a path to open
    pub async fn folder_to_open(&self, id: &str) -> Result<PathBuf, String> {
        let folder = PathBuf::from(self.require(id)?.folder);
        let check = folder.clone();
        let is_dir = tokio::time::timeout(FOLDER_CHECK, tokio::task::spawn_blocking(move || check.is_dir())).await;
        match is_dir {
            Ok(Ok(true)) => Ok(folder),
            _ => Err("open_failed".into()),
        }
    }

    /// The stored token of a project, verified without it reaching the page
    pub async fn verify_project_token(&self, id: &str) -> Result<TokenCheck, String> {
        let token = self.store.token(&self.require(id)?);
        Ok(self.verify_token(&token).await)
    }

    /* ---------------------------------------------------------------- editing */

    pub async fn create(self: &Arc<Self>, input: NewProjectInput) -> Result<ProjectView, String> {
        let _edit = self.edits.lock().await;
        let label = input.label.trim().to_string();
        let token = input.token.trim().to_string();
        if label.is_empty() || token.is_empty() {
            return Err("invalid_input".into());
        }
        let (folder, info) = self.checked_folder(&input.folder, None).await?;
        let id = uuid::Uuid::new_v4().to_string();
        let fields = self.store.store_token(&id, &token);
        let project = StoredProject {
            id: id.clone(),
            label,
            folder,
            keep_old_files: input.keep_old_files,
            created_at: op_media_service::now_iso(),
            token_enc: None,
            token_plain: fields.token_plain,
            token_keyring: fields.token_keyring,
            last_result: None,
            plan: None,
            issues: None,
            folder_info: Some(info),
            onpage_project: None,
            // The user chose the folder for this token, whatever On Page project it had
            take_over_folder: true,
        };
        self.store.save_project(&project)?;
        self.configure_service(None);
        self.changed_now();
        info!("Project {id} created");
        if input.sync_now {
            self.start_job(&id, JobKind::Sync, false, false)?;
        }
        Ok(self.to_view(&project))
    }

    pub async fn update(self: &Arc<Self>, id: &str, patch: ProjectPatch) -> Result<ProjectView, String> {
        let _edit = self.edits.lock().await;
        let current = self.require(id)?;
        self.require_idle(&current)?;

        let mut label = None;
        let mut token = None;
        let mut folder = None;
        let mut reset = false;
        if let Some(value) = &patch.label {
            let value = value.trim();
            if value.is_empty() {
                return Err("invalid_input".into());
            }
            label = Some(value.to_string());
        }
        if let Some(value) = &patch.token {
            let value = value.trim();
            if value.is_empty() {
                return Err("invalid_input".into());
            }
            if value != self.store.token(&current) {
                token = Some(value.to_string());
                reset = true;
            }
        }
        if let Some(value) = &patch.folder {
            let normalized = normalize_folder(value);
            if normalized != current.folder {
                folder = Some(self.checked_folder(&normalized, Some(id)).await?);
                reset = true;
            }
        }

        // The folder inspection takes a while: the project as it is now, and still idle
        let latest = self.require(id)?;
        self.require_idle(&latest)?;
        let mut next = latest.clone();
        if let Some(label) = label {
            next.label = label;
        }
        if let Some(token) = token {
            let fields = self.store.store_token(id, &token);
            next.token_enc = None;
            next.token_keyring = fields.token_keyring;
            next.token_plain = fields.token_plain;
        }
        if let Some((folder, info)) = folder {
            next.folder = folder;
            next.folder_info = Some(info);
        }
        if let Some(keep) = patch.keep_old_files.filter(|keep| *keep != latest.keep_old_files) {
            next.keep_old_files = keep;
            // The plan was computed with the other rule
            next.plan = None;
            self.state.lock().runtimes.remove(id);
        }
        if reset {
            // Another project or another folder: what we knew does not apply
            next.plan = None;
            next.issues = Some(Vec::new());
            next.last_result = None;
            // The user's choice: the folder follows this token, also from another On Page project
            next.take_over_folder = true;
            self.state.lock().runtimes.remove(id);
            self.service.forget(id);
        }
        self.store.save_project(&next)?;
        self.configure_service(None);
        self.changed_now();
        Ok(self.to_view(&next))
    }

    /// Removes the project from the list at once. Its job is stopped and, when
    /// asked, its files are deleted in the background, with no time limit
    pub async fn remove(self: &Arc<Self>, id: &str, delete_files: bool) -> Result<(), String> {
        let _edit = self.edits.lock().await;
        let project = self.require(id)?;
        let target = self.service_project(&project);
        {
            let mut state = self.state.lock();
            if delete_files {
                state.deleting.insert(id.to_string(), target.clone());
            }
            // The runtime of a running job stays until the service says it ended
            if state.runtimes.get(id).is_none_or(|runtime| runtime.phase == JobPhase::Idle) {
                state.runtimes.remove(id);
            }
        }
        self.store.remove_project(id);
        self.configure_service(None);
        self.changed_now();
        info!("Project {id} removed{}", if delete_files { ": deleting its files" } else { "" });
        let me = self.clone();
        let id = id.to_string();
        self.runtime
            .spawn(async move { if delete_files { me.delete_files(target).await } else { me.forget(&id).await } });
        Ok(())
    }

    /* ---------------------------------------------------------------- jobs */

    /// Starts a job unless one runs. `take_over_folder`: the user chose to use
    /// the folder of another On Page project for this one, until a job saves
    /// the folder's registry
    pub fn start_job(
        self: &Arc<Self>,
        id: &str,
        job: JobKind,
        full_listing: bool,
        take_over_folder: bool,
    ) -> Result<(), String> {
        let mut project = self.require(id)?;
        if self.runtime(&project).phase != JobPhase::Idle {
            return Ok(());
        }
        if take_over_folder {
            project = self.store.patch_project(id, |p| p.take_over_folder = true).unwrap_or(project);
        }
        self.mark_starting(&project, job);
        let target = self.service_project(&project);
        match job {
            JobKind::Sync => self.service.sync(target, full_listing),
            JobKind::Download => self.service.download(target),
            JobKind::RetryFailed => self.service.retry_failed(target),
            JobKind::Cleanup => self.service.confirm_cleanup(target),
        }
        Ok(())
    }

    pub fn sync_all(self: &Arc<Self>) {
        for project in self.store.projects() {
            let _ = self.start_job(&project.id, JobKind::Sync, false, false);
        }
    }

    pub fn stop(self: &Arc<Self>, id: &str) {
        {
            let mut state = self.state.lock();
            let Some(runtime) = state.runtimes.get_mut(id) else {
                return;
            };
            if runtime.phase == JobPhase::Idle {
                return;
            }
            runtime.phase = JobPhase::Stopping;
        }
        self.service.stop(id);
        self.changed_now();
    }

    /// Stops every job and waits for the service to save its work
    pub async fn stop_all(self: &Arc<Self>, timeout: Duration) {
        let running: Vec<ProjectId> = {
            let state = self.state.lock();
            state.runtimes.iter().filter(|(_, r)| r.phase != JobPhase::Idle).map(|(id, _)| id.clone()).collect()
        };
        for id in &running {
            self.stop(id);
        }
        self.wait_idle(&running, timeout).await;
    }

    pub fn activity(&self, id: &str, limit: Option<usize>) -> Result<Vec<ActivityEntry>, String> {
        self.require(id)?;
        Ok(self.service.activity(id, limit))
    }

    pub fn failed(&self, id: &str, page: &PageQuery) -> Result<FailedPage, String> {
        self.require(id)?;
        Ok(self.service.failed(id, page))
    }

    pub async fn duplicates(&self, id: &str, page: PageQuery) -> Result<DuplicatePage, String> {
        let project = self.require(id)?;
        self.service.duplicates(self.service_project(&project), page).await
    }

    pub async fn duplicate_variants(&self, id: &str, query: VariantsQuery) -> Result<DuplicateVariants, String> {
        let project = self.require(id)?;
        self.service.duplicate_variants(self.service_project(&project), query).await
    }

    pub async fn verify_token(&self, token: &str) -> TokenCheck {
        let token = token.trim();
        if token.is_empty() {
            return TokenCheck { ok: false, error: Some(TokenError::TokenInvalid), ..Default::default() };
        }
        self.service.verify_token(token.to_string()).await
    }

    /// A folder the user picked
    pub async fn inspect(&self, folder: &str, project_id: Option<ProjectId>) -> FolderInfo {
        let mut info = self.service.inspect_folder(normalize_folder(folder), project_id).await;
        // The service names the other project by id: the user knows it by its label
        if info.problems.contains(&FolderProblem::UsedByOtherProject)
            && let Some(other) = info.problem_detail.clone()
        {
            let label = self
                .store
                .project(&other)
                .map(|p| p.label)
                .or_else(|| self.state.lock().deleting.get(&other).map(|p| p.label.clone()));
            info.problem_detail = Some(label.unwrap_or(other));
        }
        info
    }

    /// Refreshes kind, free space and hard links of every folder, one at a time
    pub async fn refresh_folders(self: &Arc<Self>) {
        for project in self.store.projects() {
            self.refresh_folder(&project.id).await;
        }
    }

    pub async fn refresh_folder(self: &Arc<Self>, id: &str) {
        let Some(project) = self.store.project(id) else {
            return;
        };
        let info = self.inspect(&project.folder, Some(id.to_string())).await;
        self.store.patch_project(id, |p| p.folder_info = Some(info));
        self.changed();
    }

    pub fn configure_service(&self, concurrency: Option<u32>) {
        self.service.configure(concurrency, Some(self.project_folders()));
    }

    /// The folders of the projects, and of the removed ones whose files are being deleted
    pub fn project_folders(&self) -> Vec<ProjectFolder> {
        let mut folders: Vec<ProjectFolder> =
            self.store.projects().into_iter().map(|p| ProjectFolder { id: p.id, folder: p.folder }).collect();
        folders.extend(
            self.state.lock().deleting.values().map(|p| ProjectFolder { id: p.id.clone(), folder: p.folder.clone() }),
        );
        folders
    }

    /* ---------------------------------------------------------------- removed projects */

    /// The job of a removed project ends, then the service drops what it kept of it
    async fn forget(self: &Arc<Self>, id: &str) {
        self.stop_removed(id).await;
        self.state.lock().runtimes.remove(id);
        self.service.forget(id);
    }

    /// The service answers `project_busy` while a job of the project runs: it is stopped first
    async fn delete_files(self: &Arc<Self>, project: ServiceProject) {
        let id = project.id.clone();
        let mut attempt = 1;
        let outcome = loop {
            self.stop_removed(&id).await;
            match self.service.delete_project_files(project.clone()).await {
                Ok(result) => break Ok(result),
                Err(error) => {
                    let code = error.split(':').next().unwrap_or("").trim().to_string();
                    if attempt >= DELETE_ATTEMPTS || !DELETE_RETRY_ERRORS.contains(&code.as_str()) {
                        break Err((code, error));
                    }
                    warn!("Deleting the files of project {id}: {code}, trying again");
                    attempt += 1;
                }
            }
        };
        match outcome {
            Ok(result) => info!(
                "Project {id} files removed: {} files, folder {}",
                result.removed_files,
                if result.removed_folder {
                    "removed".to_string()
                } else {
                    format!("kept ({} other entries)", result.kept_entries)
                }
            ),
            Err((code, error)) => {
                error!("The files of project {id} could not be deleted from {}: {error}", project.folder);
                self.service.forget(&id);
                (self.notify)(ProjectsEvent::DeleteFailed { label: project.label.clone(), code });
            }
        }
        {
            let mut state = self.state.lock();
            state.runtimes.remove(&id);
            state.deleting.remove(&id);
        }
        self.configure_service(None);
        self.changed();
    }

    async fn stop_removed(self: &Arc<Self>, id: &str) {
        let running = self.state.lock().runtimes.get(id).is_some_and(|r| r.phase != JobPhase::Idle);
        if !running {
            return;
        }
        self.stop(id);
        self.wait_idle(&[id.to_string()], STOP_WAIT).await;
    }

    /* ---------------------------------------------------------------- service events */

    pub fn on_service_event(self: &Arc<Self>, event: ServiceEvent) {
        match event {
            ServiceEvent::State { project_id, runtime } => {
                let Some(project) = self.store.project(&project_id) else {
                    return self.removed_state(&project_id, Some(runtime));
                };
                let idle = runtime.phase == JobPhase::Idle;
                let runtime = ProjectRuntime {
                    // The app decides what counts as the last completed run (see handle_result)
                    last_result: self.runtime(&project).last_result,
                    ..runtime
                };
                self.state.lock().runtimes.insert(project_id, runtime.clone());
                if idle {
                    self.persist(&project, &runtime);
                }
                self.changed();
            }
            ServiceEvent::Activity { project_id, entries } => {
                (self.notify)(ProjectsEvent::Activity(project_id, entries))
            }
            ServiceEvent::Result { project_id, result } => {
                if self.store.project(&project_id).is_none() {
                    return self.removed_state(&project_id, None);
                }
                self.handle_result(&project_id, result);
            }
            ServiceEvent::Log { level, message, project_id } => {
                let project = project_id.map(|id| format!(" [{id}]")).unwrap_or_default();
                crate::log::log(level, format!("[service]{project} {message}"));
            }
        }
    }

    /// A removed project whose job is still ending: only whether it runs matters (quitting, deleting its files)
    fn removed_state(self: &Arc<Self>, id: &str, runtime: Option<ProjectRuntime>) {
        {
            let mut state = self.state.lock();
            if !state.runtimes.contains_key(id) {
                return;
            }
            match runtime {
                Some(runtime) if runtime.phase != JobPhase::Idle => {
                    state.runtimes.insert(id.to_string(), runtime);
                }
                _ => {
                    state.runtimes.remove(id);
                }
            }
        }
        self.changed();
    }

    fn handle_result(self: &Arc<Self>, id: &str, result: SyncResult) {
        let Some(mut project) = self.store.project(id) else {
            return;
        };
        let runtime = self.runtime(&project);
        // «Sincronizzato» is the last run that completed: a comparison that
        // leaves files to download, a stop or a failure (shown by the issues) do not count
        let finished = result.outcome == SyncOutcome::Completed
            && (result.job != JobKind::Sync || !runtime.plan.as_ref().is_some_and(|plan| plan.to_download_names > 0));
        let next = ProjectRuntime {
            phase: JobPhase::Idle,
            progress: None,
            last_result: if finished { Some(result.clone()) } else { runtime.last_result.clone() },
            ..runtime
        };
        self.state.lock().runtimes.insert(id.to_string(), next.clone());
        // The folder's registry names this project's On Page project now: the choice of the folder is done
        if let Some(onpage) = &result.onpage_project
            && let Some(patched) = self.store.patch_project(id, |p| {
                p.onpage_project = Some(onpage.clone());
                p.take_over_folder = false;
            })
        {
            project = patched;
        }
        let saved = self.persist(&project, &next);
        self.changed();
        info!(
            "Project {id} {} {:?}: {} downloaded, {} linked, {} removed, {} failed",
            result.job.as_str(),
            result.outcome,
            result.downloaded,
            result.linked,
            result.removed,
            result.failed
        );
        (self.notify)(ProjectsEvent::Result(Box::new(self.to_view(&saved)), Box::new(result.clone())));
        self.schedule_auto_retry(id, &result);
        let me = self.clone();
        let id = id.to_string();
        self.runtime.spawn(async move { me.refresh_folder(&id).await });
    }

    fn schedule_auto_retry(self: &Arc<Self>, id: &str, result: &SyncResult) {
        if !self.store.settings().auto_retry_failed {
            return;
        }
        if result.failed == 0 || result.job == JobKind::RetryFailed || result.outcome == SyncOutcome::Stopped {
            return;
        }
        let key = format!("{id}:{}", result.started_at);
        if !self.state.lock().auto_retried.insert(key) {
            return;
        }
        let me = self.clone();
        let id = id.to_string();
        self.runtime.spawn(async move {
            tokio::time::sleep(AUTO_RETRY_DELAY).await;
            if let Some(project) = me.store.project(&id)
                && me.runtime(&project).phase == JobPhase::Idle
            {
                let _ = me.start_job(&id, JobKind::RetryFailed, false, false);
            }
        });
    }

    /* ---------------------------------------------------------------- helpers */

    fn to_view(&self, project: &StoredProject) -> ProjectView {
        ProjectView {
            id: project.id.clone(),
            label: project.label.clone(),
            folder: project.folder.clone(),
            keep_old_files: project.keep_old_files,
            created_at: project.created_at.clone(),
            // A token that cannot be read here does not count: the page asks for one
            has_token: self.store.has_token(project),
            runtime: self.runtime(project),
            folder_info: project.folder_info.clone(),
            onpage_project: project.onpage_project.clone(),
        }
    }

    fn runtime(&self, project: &StoredProject) -> ProjectRuntime {
        self.state.lock().runtimes.get(&project.id).cloned().unwrap_or_else(|| ProjectRuntime {
            phase: JobPhase::Idle,
            plan: project.plan.clone(),
            last_result: project.last_result.clone(),
            issues: project.issues.clone().unwrap_or_default(),
            ..Default::default()
        })
    }

    fn persist(&self, project: &StoredProject, runtime: &ProjectRuntime) -> StoredProject {
        let issues: Vec<Issue> =
            runtime.issues.iter().filter(|issue| PERSISTED_ISSUES.contains(&issue.code)).cloned().collect();
        self.store
            .patch_project(&project.id, |p| {
                p.plan = runtime.plan.clone();
                p.last_result = runtime.last_result.clone();
                p.issues = Some(issues);
            })
            .unwrap_or_else(|| project.clone())
    }

    /// Shows the job as started at once, before the service's first state
    fn mark_starting(self: &Arc<Self>, project: &StoredProject, job: JobKind) {
        let mut runtime = self.runtime(project);
        runtime.phase = JobPhase::Preparing;
        runtime.job = Some(job);
        runtime.issues.retain(|issue| issue.code != IssueCode::Interrupted);
        self.state.lock().runtimes.insert(project.id.clone(), runtime);
        self.changed_now();
    }

    fn service_project(&self, project: &StoredProject) -> ServiceProject {
        ServiceProject {
            id: project.id.clone(),
            label: project.label.clone(),
            token: self.store.token(project),
            folder: project.folder.clone(),
            keep_old_files: project.keep_old_files,
            take_over_folder: project.take_over_folder,
            onpage_project_id: project.onpage_project.as_ref().map(|p| p.id),
        }
    }

    /// A folder a project can use: normalized, inspected, not protected nor taken
    async fn checked_folder(&self, raw: &str, project_id: Option<&str>) -> Result<(String, FolderInfo), String> {
        let folder = normalize_folder(raw);
        if folder.is_empty() {
            return Err("invalid_input".into());
        }
        let info = self.inspect(&folder, project_id.map(str::to_string)).await;
        if let Some(blocking) = info.problems.iter().find(|problem| BLOCKING_PROBLEMS.contains(problem)) {
            let code =
                serde_json::to_value(blocking).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
            return Err(format!("folder_{code}"));
        }
        Ok((folder, info))
    }

    fn require(&self, id: &str) -> Result<StoredProject, String> {
        self.store.project(id).ok_or_else(|| "project_not_found".to_string())
    }

    fn require_idle(&self, project: &StoredProject) -> Result<(), String> {
        if self.runtime(project).phase != JobPhase::Idle { Err("project_busy".into()) } else { Ok(()) }
    }

    async fn wait_idle(&self, ids: &[ProjectId], timeout: Duration) {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.changes.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let done = {
                let state = self.state.lock();
                ids.iter().all(|id| state.runtimes.get(id).is_none_or(|r| r.phase == JobPhase::Idle))
            };
            if done {
                return;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return;
            }
        }
    }

    /// A change the user made (a click, a form): the page hears of it at once
    fn changed_now(self: &Arc<Self>) {
        self.changes.notify_waiters();
        let me = self.clone();
        self.runtime.spawn(async move {
            *me.last_change.lock() = Some(Instant::now());
            (me.notify)(ProjectsEvent::Changed(me.views()));
        });
    }

    /// The page hears of a change at once when it heard of none in the last
    /// 100 ms (a click shows without delay), else with the others of those
    /// 100 ms. Sent from a task: the caller may hold the locks the views read
    fn changed(self: &Arc<Self>) {
        self.changes.notify_waiters();
        if self.change_scheduled.swap(true, Ordering::AcqRel) {
            return;
        }
        let wait = self.last_change.lock().map_or(Duration::ZERO, |at| CHANGE_INTERVAL.saturating_sub(at.elapsed()));
        let me = self.clone();
        self.runtime.spawn(async move {
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
            me.change_scheduled.store(false, Ordering::Release);
            *me.last_change.lock() = Some(Instant::now());
            (me.notify)(ProjectsEvent::Changed(me.views()));
        });
    }
}

/// Trimmed, separators of the platform, no trailing separator but the root's (`C:\`, `/`)
pub fn normalize_folder(folder: &str) -> String {
    let trimmed = folder.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let path: PathBuf = Path::new(trimmed).components().filter(|c| !matches!(c, Component::CurDir)).collect();
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_are_normalized() {
        assert_eq!(normalize_folder("   "), "");
        #[cfg(windows)]
        {
            assert_eq!(normalize_folder(" D:\\Media\\ "), "D:\\Media");
            assert_eq!(normalize_folder("D:/Media/./Foto/"), "D:\\Media\\Foto");
            assert_eq!(normalize_folder("C:\\"), "C:\\");
            assert_eq!(normalize_folder("\\\\nas\\share\\media\\"), "\\\\nas\\share\\media");
        }
        #[cfg(not(windows))]
        {
            assert_eq!(normalize_folder(" /media/foto/ "), "/media/foto");
            assert_eq!(normalize_folder("/"), "/");
            assert_eq!(normalize_folder("/media//./foto"), "/media/foto");
        }
    }
}
