/**
 * Domain model shared by the sync engine (utility process), the main process
 * and the renderer. The engine produces these shapes, main persists and
 * relays them, the renderer only displays them.
 */

export type ProjectId = string
export type FileToken = string
export type IsoDate = string

/* ------------------------------------------------------------------ Projects */

/** What the user configures. The API token is kept apart (encrypted by main). */
export interface ProjectConfig {
  id: ProjectId
  label: string
  folder: string
  /** Keep local files that are no longer on On Page (never removes them) */
  keep_old_files: boolean
  created_at: IsoDate
}

/** A project as the renderer sees it: configuration + live state, never the token */
export interface ProjectView extends ProjectConfig {
  has_token: boolean
  runtime: ProjectRuntime
  /** Last folder inspection (kind, space, hard links), refreshed by main */
  folder_info?: FolderInfo
  /** The On Page project of the token, as the last job that saved the folder's registry found it */
  onpage_project?: OnPageProject
}

/** A project on On Page: its id never changes, its label can */
export interface OnPageProject {
  id: number
  label: string
}

/* ------------------------------------------------------------------ Folders */

export type DestinationKind = 'local' | 'network' | 'removable' | 'unknown'

export type FolderProblem =
  /** The path (or its share) does not answer */
  | 'unreachable'
  /** The app cannot create files there */
  | 'not_writable'
  /** A drive root, the home folder or a system folder */
  | 'protected'
  /** Same folder as another project, or nested in / around one */
  | 'used_by_other_project'
  /** Another computer or instance is syncing this folder right now */
  | 'locked'
  /** The folder already has a `data` folder the app did not create: never used, emptied or deleted */
  | 'foreign_data'

export interface FolderInfo {
  path: string
  kind: DestinationKind
  exists: boolean
  writable: boolean
  free_bytes?: number
  /** Hard links supported: when false every file is copied and takes twice the space */
  hardlinks?: boolean
  /** Entries in the folder that the app did not create (they are never touched) */
  foreign_entries?: number
  problems: FolderProblem[]
  /** For `used_by_other_project` / `locked`: who */
  problem_detail?: string
  /** The On Page project the folder is synced with, from its registry */
  onpage_project?: OnPageProject
  inspected_at: IsoDate
}

/* ------------------------------------------------------------------ Runtime */

/**
 * What the engine is doing for a project. `idle` means nothing runs; the
 * outcome of the last run is in `last_result`, what is left to do in `plan`.
 */
export type JobPhase =
  | 'idle'
  /** Folder checks, lock, manifest */
  | 'preparing'
  /** Reading the file list from On Page */
  | 'listing'
  /** Reading the folder and computing the plan */
  | 'comparing'
  | 'downloading'
  /** Links and removals after the downloads */
  | 'finishing'
  | 'stopping'

export type JobKind = 'sync' | 'download' | 'retry_failed' | 'cleanup'

export interface ProjectRuntime {
  phase: JobPhase
  job?: JobKind
  /** Present while a job runs */
  progress?: Progress
  /** Result of the last "Sincronizza": what is left to do */
  plan?: PlanSummary
  /** Last finished job (download, retry or a sync that applied changes) */
  last_result?: SyncResult
  /** Current problems, most severe first */
  issues: Issue[]
}

export interface Progress {
  started_at: IsoDate
  /** Listing: resources read so far */
  listing?: {
    resource_label?: string
    resources_done: number
    resources_total: number
    things_read: number
    things_total?: number
  }
  /** Execution counters (names, not tokens) */
  total: number
  downloaded: number
  linked: number
  removed: number
  already_present: number
  failed: number
  bytes_done: number
  bytes_total: number
  /** Smoothed speed, bytes per second */
  speed_bps: number
  eta_seconds?: number
  /** Files transferring right now */
  in_flight: number
  concurrency: number
}

export interface PlanSummary {
  created_at: IsoDate
  /** Unique local names wanted from On Page */
  remote_names: number
  remote_bytes: number
  /** Contents to download (one per token) and the names they serve */
  to_download: number
  to_download_names: number
  to_download_bytes: number
  /** Names to (re)link to a content already in data/ */
  to_link: number
  /** Names and contents to remove (never when keep_old_files) */
  to_remove: number
  /** Names already in place */
  up_to_date: number
  /** Names with different files on On Page: the first one wins */
  duplicates: number
  /** Names that exist in the folder but were not created by the app (left alone) */
  conflicts: number
  /** Removals above the safety threshold wait for a confirmation */
  cleanup_needs_confirmation: boolean
  /** The listing was incremental (cache) or full */
  listing: 'full' | 'incremental'
}

export type SyncOutcome = 'completed' | 'stopped' | 'failed'

export interface SyncResult {
  job: JobKind
  started_at: IsoDate
  ended_at: IsoDate
  outcome: SyncOutcome
  total: number
  downloaded: number
  linked: number
  removed: number
  already_present: number
  failed: number
  bytes: number
  /** Set when outcome is `failed` */
  error?: Issue
  /** The token's On Page project, when the folder's registry on the disk names it after this job */
  onpage_project?: OnPageProject
}

/* ------------------------------------------------------------------ Issues */

export type IssueCode =
  /** 401/403 from On Page */
  | 'token_invalid'
  /** The schema could not be loaded for another reason */
  | 'project_unavailable'
  /** The file list could not be read (after retries) */
  | 'listing_failed'
  /** On Page answered 429 and the job is waiting */
  | 'rate_limited'
  | 'folder_unreachable'
  | 'folder_not_writable'
  | 'folder_protected'
  | 'folder_locked'
  /** The folder is synced with another On Page project: nothing was touched (the detail names it) */
  | 'folder_other_project'
  | 'disk_full'
  | 'offline'
  /** Names with different files on On Page */
  | 'duplicates'
  /** Files not downloaded in the last run */
  | 'failed_files'
  /** The folder copies instead of linking (double space) */
  | 'copies_instead_of_links'
  /** Names in the folder not created by the app block a remote file */
  | 'name_conflicts'
  /** More removals than the safety threshold: waiting for the user */
  | 'cleanup_needs_confirmation'
  /** The last job stopped unexpectedly (the engine restarted): run it again */
  | 'interrupted'
  /** An error the engine does not know: the detail says which */
  | 'unexpected'
  /** Some collections could not be read: nothing was removed (the detail names them) */
  | 'listing_incomplete'

export interface Issue {
  code: IssueCode
  severity: 'warning' | 'error'
  count?: number
  /** Technical detail for the log or a tooltip (never shown as the main text) */
  detail?: string
  at: IsoDate
}

/* ------------------------------------------------------------------ Activity */

export type ActivityOutcome = 'downloading' | 'downloaded' | 'linked' | 'removed' | 'failed' | 'conflict'

export interface ActivityEntry {
  id: number
  at: IsoDate
  /** Local file name */
  name: string
  token?: FileToken
  size?: number
  outcome: ActivityOutcome
  /** 0..1 while downloading */
  progress?: number
  /** Why it failed or was skipped, short and human (already translated by code) */
  reason?: FailureCode
  /** For `linked`: the name it shares the content with */
  same_as?: string
}

export type FailureCode =
  /** Not on On Page anymore */
  | 'not_found'
  | 'http_error'
  | 'rate_limited'
  | 'network'
  | 'timeout'
  | 'size_mismatch'
  | 'disk_full'
  | 'write_error'
  | 'link_error'
  | 'invalid_name'
  | 'name_conflict'
  | 'aborted'
  /** Open in another program (Windows): it cannot be replaced or removed now */
  | 'in_use'
  /** More than the disk takes in one file (4 GB on FAT32) */
  | 'file_too_large'

export interface FailedEntry {
  name: string
  token: FileToken
  size?: number
  reason: FailureCode
  /** HTTP status or error code, for the log */
  detail?: string
  attempts: number
  at: IsoDate
}

/* ------------------------------------------------------------------ Duplicates */

export interface DuplicateUse {
  resource_label: string
  field_label: string
  thing_id: number
  thing_label?: string
  lang?: string
  /** Link to the thing in On Page */
  edit_url: string
}

export interface DuplicateVariant {
  token: FileToken
  size?: number
  width?: number
  height?: number
  /** Small preview from On Page storage, when it is an image */
  thumb_url?: string
  /** The variant that is downloaded (the first one found) */
  chosen: boolean
  uses: DuplicateUse[]
}

export interface DuplicateGroup {
  /** The name as shown (case of the chosen variant) */
  name: string
  /** The chosen one first; at most a few of them (generated files can share a name by the thousands) */
  variants: DuplicateVariant[]
  /** The variants of the name not in `variants` */
  more_variants?: number
}

/** Long lists (tens of thousands of entries) travel a page at a time */
export interface PageQuery {
  offset: number
  limit: number
  /** Part of the name, any case */
  query?: string
  /**
   * Duplicates: false answers at once with the labels of the things already
   * known (`labels_pending` says some are missing); true (the default) reads
   * them from On Page first
   */
  labels?: boolean
}

/** More files of one duplicate name (it can have thousands), after those shown */
export interface VariantsQuery {
  /** The name as the page gave it */
  name: string
  /** The files already shown */
  offset: number
  limit: number
  /** As in `PageQuery` */
  labels?: boolean
}

export interface DuplicateVariants {
  variants: DuplicateVariant[]
  /** The files of the name after these */
  more_variants: number
  labels_pending?: boolean
}

export interface DuplicatePage {
  /** Groups matching the query */
  total: number
  /** Of all the groups: names whose files are one field of one item in different languages */
  language_variants: number
  groups: DuplicateGroup[]
  /** Some things of the page have labels not read yet (asked with `labels: false`) */
  labels_pending?: boolean
}

export interface FailedPage {
  total: number
  entries: FailedEntry[]
}

/* ------------------------------------------------------------------ Token check */

export interface TokenCheck {
  ok: boolean
  error?: 'token_invalid' | 'offline' | 'project_unavailable'
  /** The On Page project of the token */
  project_id?: number
  project_label?: string
  /** Collections with at least one file or image field */
  collections_with_files?: number
  langs?: string[]
}

/* ------------------------------------------------------------------ Settings */

export type ThemeSetting = 'system' | 'light' | 'dark'
/** The languages of On Page UI */
export const LANGUAGES = ['it', 'en', 'de', 'es', 'fr', 'ru', 'sv', 'zh'] as const
export type AppLanguage = (typeof LANGUAGES)[number]

export interface AppSettings {
  theme: ThemeSetting
  language: AppLanguage
  /** Parallel downloads per project, 1..10 */
  concurrency: number
  /** Retry network failures once, a minute after the end of a download */
  auto_retry_failed: boolean
  notifications: boolean
  /** Icon in the notification area; closing the window keeps the app running there */
  close_to_tray: boolean
  /** Start with the system, in the notification area */
  open_at_login: boolean
  /** Look for a new version on GitHub at start-up */
  check_updates: boolean
  /** AI agents and the opmd command reach the app while it is open (its MCP server on 127.0.0.1) */
  agent_access: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  language: 'it',
  concurrency: 4,
  auto_retry_failed: false,
  notifications: true,
  close_to_tray: false,
  open_at_login: false,
  check_updates: true,
  agent_access: true,
}

/* ------------------------------------------------------------------ App info */

export interface VersionInfo {
  current: string
  latest?: string
  release_url?: string
  checked_at?: IsoDate
  /** The last check could not reach GitHub */
  check_failed?: boolean
}

export interface AppStatus {
  online: boolean
  running_jobs: number
  speed_bps: number
  total_files: number
  total_bytes: number
}

/** «Agenti AI»: whether the app's MCP server is open, and where (its secret never reaches the page) */
export interface AgentAccess {
  open: boolean
  url?: string
  /** `opmd` installed beside the app: its path (none in development) */
  opmd?: string
}
