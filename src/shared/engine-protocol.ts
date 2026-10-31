/**
 * Messages between the main process and the sync engine, which runs in an
 * Electron utility process (`src/engine/index.ts`, built to `out/main/engine.js`).
 *
 * Main sends commands and requests; the engine answers requests with a
 * `response` carrying the same `request_id`, and pushes state, activity and
 * results on its own. One job at a time per project; jobs of different
 * projects run side by side.
 */
import {
  ActivityEntry,
  DuplicateGroup,
  FailedEntry,
  FolderInfo,
  ProjectId,
  ProjectRuntime,
  SyncResult,
  TokenCheck,
} from './models'

/** Everything the engine needs to work on a project */
export interface EngineProject {
  id: ProjectId
  label: string
  token: string
  folder: string
  keep_old_files: boolean
}

export interface EngineInit {
  /** Local folder for listing caches (userData/cache), one file per project */
  cache_dir: string
  /** Folders of all projects, to detect overlaps when inspecting a folder */
  project_folders: { id: ProjectId; folder: string }[]
  concurrency: number
  app_version: string
  /** For logs and the folder lock */
  instance_id: string
  /**
   * Development and tests only: On Page domain to use instead of
   * https://app.onpage.it (e.g. http://127.0.0.1:4310 for a fake server that
   * answers both the API and the storage links)
   */
  api_domain?: string
}

/* ------------------------------------------------------------------ main → engine */

export type EngineCommand =
  | { type: 'init'; init: EngineInit }
  | { type: 'configure'; concurrency?: number; project_folders?: EngineInit['project_folders'] }
  /**
   * «Sincronizza»: list (incremental when possible), scan, plan. When nothing
   * needs downloading, links and removals within the safety threshold are
   * applied at once and the job ends as a completed sync.
   */
  | { type: 'sync'; project: EngineProject; full_listing?: boolean }
  /** «Scarica»: execute the plan (re-planning first when it is stale) */
  | { type: 'download'; project: EngineProject }
  /** Download again only the files that failed in the last run */
  | { type: 'retry_failed'; project: EngineProject }
  /** Apply removals above the safety threshold after the user confirmed */
  | { type: 'confirm_cleanup'; project: EngineProject }
  | { type: 'stop'; project_id: ProjectId }
  /** The project was removed or its token/folder changed: drop plans and caches in memory */
  | { type: 'forget'; project_id: ProjectId }

export type EngineRequest =
  | { type: 'inspect_folder'; path: string; project_id?: ProjectId }
  | { type: 'verify_token'; token: string }
  | { type: 'get_activity'; project_id: ProjectId; limit?: number }
  | { type: 'get_failed'; project_id: ProjectId }
  /** Fetches thing labels for the groups on demand */
  | { type: 'get_duplicates'; project: EngineProject }
  /** Removes data/, the names in the manifest and the folder when left empty */
  | { type: 'delete_project_files'; project: EngineProject }

export type EngineRequestEnvelope = { request_id: number; request: EngineRequest }

export type MainToEngine =
  | { kind: 'command'; command: EngineCommand }
  | ({ kind: 'request' } & EngineRequestEnvelope)

/* ------------------------------------------------------------------ engine → main */

export interface DeleteFilesResult {
  removed_files: number
  removed_folder: boolean
  /** Entries left because the app did not create them */
  kept_entries: number
}

export type EngineResponseData =
  | FolderInfo
  | TokenCheck
  | ActivityEntry[]
  | FailedEntry[]
  | DuplicateGroup[]
  | DeleteFilesResult

export type EngineToMain =
  /** Throttled by the engine (at most ~4 per second per project) */
  | { kind: 'state'; project_id: ProjectId; runtime: ProjectRuntime }
  /** Batched, newest last */
  | { kind: 'activity'; project_id: ProjectId; entries: ActivityEntry[] }
  /** A job ended (also emitted as the last `state`) */
  | { kind: 'result'; project_id: ProjectId; result: SyncResult }
  | {
      kind: 'response'
      request_id: number
      ok: boolean
      data?: EngineResponseData
      error?: string
    }
  | { kind: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; project_id?: ProjectId }
  | { kind: 'ready' }
