//! The domain model the service produces and its users (the app, the page)
//! read. Serialized exactly as the TypeScript types of `src/shared/models.ts`:
//! snake_case names, optional fields left out when missing.

use serde::{Deserialize, Serialize};

pub type ProjectId = String;
pub type FileToken = String;
/// An ISO 8601 date in UTC with milliseconds, as JavaScript's `toISOString`
pub type IsoDate = String;

/// Now, as JavaScript's `new Date().toISOString()`
pub fn now_iso() -> IsoDate {
    iso(chrono::Utc::now())
}

pub fn iso(date: chrono::DateTime<chrono::Utc>) -> IsoDate {
    date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Milliseconds since the epoch as an ISO date
pub fn iso_ms(ms: i64) -> IsoDate {
    chrono::DateTime::from_timestamp_millis(ms).map(iso).unwrap_or_else(now_iso)
}

/// An ISO date in milliseconds since the epoch
pub fn parse_iso_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value).ok().map(|d| d.timestamp_millis())
}

/* ------------------------------------------------------------------ Projects */

/// A project on On Page: its id never changes, its label can
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OnPageProject {
    pub id: i64,
    pub label: String,
}

/// Everything the service needs to work on a project
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServiceProject {
    pub id: ProjectId,
    pub label: String,
    pub token: String,
    pub folder: String,
    pub keep_old_files: bool,
    /// The user chose this folder for this token (a new project, another token
    /// or another folder): the job may take the folder over from another On
    /// Page project
    #[serde(default)]
    pub take_over_folder: bool,
    /// The On Page project the project last synced: its files are deleted only
    /// from a folder still of that project
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub onpage_project_id: Option<i64>,
}

/// A project's folder, to detect overlaps between projects
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectFolder {
    pub id: ProjectId,
    pub folder: String,
}

/* ------------------------------------------------------------------ Folders */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DestinationKind {
    Local,
    Network,
    Removable,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderProblem {
    /// The path (or its share) does not answer
    Unreachable,
    /// The app cannot create files there
    NotWritable,
    /// A drive root, the home folder or a system folder
    Protected,
    /// Same folder as another project, or nested in / around one
    UsedByOtherProject,
    /// Another computer or instance is syncing this folder right now
    Locked,
    /// The folder already has a `data` folder the app did not create
    ForeignData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderInfo {
    pub path: String,
    pub kind: DestinationKind,
    pub exists: bool,
    pub writable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub free_bytes: Option<u64>,
    /// Hard links supported: when false every file is copied and takes twice the space
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hardlinks: Option<bool>,
    /// Entries in the folder that the app did not create (they are never touched)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreign_entries: Option<u64>,
    pub problems: Vec<FolderProblem>,
    /// For `used_by_other_project` / `locked`: who
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem_detail: Option<String>,
    /// The On Page project the folder is synced with, from its registry
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub onpage_project: Option<OnPageProject>,
    pub inspected_at: IsoDate,
}

/* ------------------------------------------------------------------ Runtime */

/// What the service is doing for a project. `idle` means nothing runs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum JobPhase {
    #[default]
    Idle,
    /// Folder checks, lock, manifest
    Preparing,
    /// Reading the file list from On Page
    Listing,
    /// Reading the folder and computing the plan
    Comparing,
    Downloading,
    /// Links and removals after the downloads
    Finishing,
    Stopping,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Sync,
    Download,
    RetryFailed,
    Cleanup,
}

impl JobKind {
    pub fn as_str(self) -> &'static str {
        match self {
            JobKind::Sync => "sync",
            JobKind::Download => "download",
            JobKind::RetryFailed => "retry_failed",
            JobKind::Cleanup => "cleanup",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectRuntime {
    pub phase: JobPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job: Option<JobKind>,
    /// Present while a job runs
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<Progress>,
    /// Result of the last «Sincronizza»: what is left to do
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<PlanSummary>,
    /// Last finished job
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_result: Option<SyncResult>,
    /// Current problems, most severe first
    #[serde(default)]
    pub issues: Vec<Issue>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ListingProgress {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_label: Option<String>,
    pub resources_done: u64,
    pub resources_total: u64,
    pub things_read: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub things_total: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Progress {
    pub started_at: IsoDate,
    /// Listing: resources read so far
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listing: Option<ListingProgress>,
    /// Execution counters (names, not tokens)
    pub total: u64,
    pub downloaded: u64,
    pub linked: u64,
    pub removed: u64,
    pub already_present: u64,
    pub failed: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// Smoothed speed, bytes per second
    pub speed_bps: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eta_seconds: Option<u64>,
    /// Files transferring right now
    pub in_flight: u64,
    pub concurrency: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ListingMode {
    #[default]
    Full,
    Incremental,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlanSummary {
    pub created_at: IsoDate,
    /// Unique local names wanted from On Page
    pub remote_names: u64,
    pub remote_bytes: u64,
    /// Contents to download (one per token) and the names they serve
    pub to_download: u64,
    pub to_download_names: u64,
    pub to_download_bytes: u64,
    /// Names to (re)link to a content already in data/
    pub to_link: u64,
    /// Names and contents to remove (never when keep_old_files)
    pub to_remove: u64,
    /// Names already in place
    pub up_to_date: u64,
    /// Names with different files on On Page: the first one wins
    pub duplicates: u64,
    /// Names that exist in the folder but were not created by the app (left alone)
    pub conflicts: u64,
    /// Removals above the safety threshold wait for a confirmation
    pub cleanup_needs_confirmation: bool,
    /// The listing was incremental (cache) or full
    pub listing: ListingMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncOutcome {
    Completed,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub job: JobKind,
    pub started_at: IsoDate,
    pub ended_at: IsoDate,
    pub outcome: SyncOutcome,
    pub total: u64,
    pub downloaded: u64,
    pub linked: u64,
    pub removed: u64,
    pub already_present: u64,
    pub failed: u64,
    pub bytes: u64,
    /// Set when outcome is `failed`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Issue>,
    /// The token's On Page project, when the folder's registry on the disk names it after this job
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub onpage_project: Option<OnPageProject>,
}

/* ------------------------------------------------------------------ Issues */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueCode {
    /// 401/403 from On Page
    TokenInvalid,
    /// The schema could not be loaded for another reason
    ProjectUnavailable,
    /// The file list could not be read (after retries)
    ListingFailed,
    /// On Page answered 429 and the job is waiting
    RateLimited,
    FolderUnreachable,
    FolderNotWritable,
    FolderProtected,
    FolderLocked,
    /// The folder is synced with another On Page project: nothing was touched
    FolderOtherProject,
    DiskFull,
    Offline,
    /// Names with different files on On Page
    Duplicates,
    /// Files not downloaded in the last run
    FailedFiles,
    /// The folder copies instead of linking (double space)
    CopiesInsteadOfLinks,
    /// Names in the folder not created by the app block a remote file
    NameConflicts,
    /// More removals than the safety threshold: waiting for the user
    CleanupNeedsConfirmation,
    /// The last job stopped unexpectedly: run it again
    Interrupted,
    /// An error the service does not know: the detail says which
    Unexpected,
    /// Some collections could not be read: nothing was removed
    ListingIncomplete,
}

impl IssueCode {
    pub fn as_str(self) -> &'static str {
        match self {
            IssueCode::TokenInvalid => "token_invalid",
            IssueCode::ProjectUnavailable => "project_unavailable",
            IssueCode::ListingFailed => "listing_failed",
            IssueCode::RateLimited => "rate_limited",
            IssueCode::FolderUnreachable => "folder_unreachable",
            IssueCode::FolderNotWritable => "folder_not_writable",
            IssueCode::FolderProtected => "folder_protected",
            IssueCode::FolderLocked => "folder_locked",
            IssueCode::FolderOtherProject => "folder_other_project",
            IssueCode::DiskFull => "disk_full",
            IssueCode::Offline => "offline",
            IssueCode::Duplicates => "duplicates",
            IssueCode::FailedFiles => "failed_files",
            IssueCode::CopiesInsteadOfLinks => "copies_instead_of_links",
            IssueCode::NameConflicts => "name_conflicts",
            IssueCode::CleanupNeedsConfirmation => "cleanup_needs_confirmation",
            IssueCode::Interrupted => "interrupted",
            IssueCode::Unexpected => "unexpected",
            IssueCode::ListingIncomplete => "listing_incomplete",
        }
    }
}

impl std::fmt::Display for IssueCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Issue {
    pub code: IssueCode,
    pub severity: Severity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    /// Technical detail for the log or a tooltip (never shown as the main text)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub at: IsoDate,
}

/* ------------------------------------------------------------------ Activity */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityOutcome {
    Downloading,
    Downloaded,
    Linked,
    Removed,
    Failed,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    /// Not on On Page anymore
    NotFound,
    HttpError,
    RateLimited,
    Network,
    Timeout,
    SizeMismatch,
    DiskFull,
    WriteError,
    LinkError,
    InvalidName,
    NameConflict,
    Aborted,
    /// Open in another program (Windows): it cannot be replaced or removed now
    InUse,
    /// More than the disk takes in one file (4 GB on FAT32)
    FileTooLarge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityEntry {
    pub id: u64,
    pub at: IsoDate,
    /// Local file name
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<FileToken>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub outcome: ActivityOutcome,
    /// 0..1 while downloading
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<FailureCode>,
    /// For `linked`: the name it shares the content with
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub same_as: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailedEntry {
    pub name: String,
    pub token: FileToken,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub reason: FailureCode,
    /// HTTP status or error code, for the log
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub attempts: u32,
    pub at: IsoDate,
}

/* ------------------------------------------------------------------ Duplicates */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateUse {
    pub resource_label: String,
    pub field_label: String,
    pub thing_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thing_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    /// Link to the thing in On Page
    pub edit_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateVariant {
    pub token: FileToken,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u64>,
    /// Small preview from On Page storage, when it is an image
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb_url: Option<String>,
    /// The variant that is downloaded (the first one found)
    pub chosen: bool,
    pub uses: Vec<DuplicateUse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateGroup {
    /// The name as shown (case of the chosen variant)
    pub name: String,
    pub variants: Vec<DuplicateVariant>,
}

/// Long lists (tens of thousands of entries) travel a page at a time
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PageQuery {
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_limit")]
    pub limit: usize,
    /// Part of the name, any case
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    /// Duplicates: the labels of the things not known yet are read from On Page
    /// before the answer; without, the page answers at once with those it knows
    #[serde(default = "yes")]
    pub labels: bool,
}

fn default_limit() -> usize {
    50
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DuplicatePage {
    /// Groups matching the query
    pub total: u64,
    /// Of all the groups: names whose files are one field of one item in different languages
    pub language_variants: u64,
    pub groups: Vec<DuplicateGroup>,
    /// Some things of the page have labels not read yet (asked without `labels`)
    #[serde(default)]
    pub labels_pending: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FailedPage {
    pub total: u64,
    pub entries: Vec<FailedEntry>,
}

/* ------------------------------------------------------------------ Token check */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenError {
    TokenInvalid,
    Offline,
    ProjectUnavailable,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenCheck {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<TokenError>,
    /// The On Page project of the token
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_label: Option<String>,
    /// Collections with at least one file or image field
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collections_with_files: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub langs: Option<Vec<String>>,
}

/* ------------------------------------------------------------------ Deleting */

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DeleteFilesResult {
    pub removed_files: u64,
    pub removed_folder: bool,
    /// Entries left because the app did not create them
    pub kept_entries: u64,
}

/* ------------------------------------------------------------------ Logs */

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Debug => "DEBUG",
            LogLevel::Info => "INFO",
            LogLevel::Warn => "WARN",
            LogLevel::Error => "ERROR",
        }
    }
}
