/**
 * The API the preload exposes to the renderer as `window.desktop`.
 * The renderer never sees Node, `ipcRenderer` or API tokens in clear (except
 * when the user asks to show the token in the project settings). Main never
 * trusts what comes from here: a folder is opened by project id, a stored
 * token is verified in main. Calls reject with an `Error` whose message is a
 * code (`project_busy`, `engine_timeout`, `open_failed`, …) or `code:detail`.
 */
import {
  ActivityEntry,
  AppSettings,
  AppStatus,
  DuplicatePage,
  FailedPage,
  FolderInfo,
  PageQuery,
  ProjectId,
  ProjectView,
  TokenCheck,
  VersionInfo,
} from './models'

export interface NewProjectInput {
  label: string
  token: string
  folder: string
  keep_old_files: boolean
  /** Start «Sincronizza» right after saving */
  sync_now?: boolean
}

export interface ProjectPatch {
  label?: string
  /** Replaces the stored token when present */
  token?: string
  folder?: string
  keep_old_files?: boolean
}

export interface DeleteProjectOptions {
  /** Also remove what the app downloaded (data/ and the linked names), never other files */
  delete_files: boolean
}

/** Commands that reach the renderer from the menu, the shortcuts, the tray or the jump list */
export type AppCommand =
  | { type: 'new_project'; folder?: string }
  | { type: 'select_project'; project_id: ProjectId; tab?: InspectorTab }
  | { type: 'sync_selected' }
  | { type: 'sync_all' }
  | { type: 'download_selected' }
  | { type: 'stop_selected' }
  | { type: 'open_folder_selected' }
  | { type: 'edit_selected' }
  | { type: 'delete_selected' }
  | { type: 'open_settings'; section?: SettingsSection }
  | { type: 'focus_search' }

export type InspectorTab = 'general' | 'activity' | 'failed' | 'duplicates' | 'settings'
export type SettingsSection = 'general' | 'download' | 'appearance' | 'language' | 'updates'

export type Unsubscribe = () => void

export interface DesktopApi {
  platform: 'win32' | 'darwin' | 'linux'

  projects: {
    list(): Promise<ProjectView[]>
    create(input: NewProjectInput): Promise<ProjectView>
    update(id: ProjectId, patch: ProjectPatch): Promise<ProjectView>
    remove(id: ProjectId, options: DeleteProjectOptions): Promise<void>
    /** Only for the token field in the project settings, after the user asks */
    revealToken(id: ProjectId): Promise<string>
    /** Pushed on every change: configuration, runtime (throttled), folder info */
    onChanged(listener: (projects: ProjectView[]) => void): Unsubscribe
  }

  sync: {
    sync(id: ProjectId, options?: { full_listing?: boolean }): Promise<void>
    syncAll(): Promise<void>
    download(id: ProjectId): Promise<void>
    retryFailed(id: ProjectId): Promise<void>
    confirmCleanup(id: ProjectId): Promise<void>
    stop(id: ProjectId): Promise<void>
    getActivity(id: ProjectId, limit?: number): Promise<ActivityEntry[]>
    onActivity(listener: (id: ProjectId, entries: ActivityEntry[]) => void): Unsubscribe
    getFailed(id: ProjectId, page: PageQuery): Promise<FailedPage>
    getDuplicates(id: ProjectId, page: PageQuery): Promise<DuplicatePage>
  }

  folders: {
    /** Native folder picker; undefined when cancelled */
    pick(default_path?: string): Promise<string | undefined>
    inspect(path: string, project_id?: ProjectId): Promise<FolderInfo>
    /** The folder of a project, as main has it recorded */
    openProject(id: ProjectId): Promise<void>
    /** Path of a folder dropped on the window (File from a drop event) */
    pathForDroppedFile(file: File): string
  }

  tokens: {
    /** A token typed in a form */
    verify(token: string): Promise<TokenCheck>
    /** The stored token of a project, verified in main: it never reaches the page */
    verifyProject(id: ProjectId): Promise<TokenCheck>
  }

  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
    onChanged(listener: (settings: AppSettings) => void): Unsubscribe
  }

  app: {
    version(): Promise<VersionInfo>
    checkForUpdates(): Promise<VersionInfo>
    /** Pushed after every check for updates (also the one at start-up) */
    onVersion(listener: (version: VersionInfo) => void): Unsubscribe
    status(): Promise<AppStatus>
    onStatus(listener: (status: AppStatus) => void): Unsubscribe
    openExternal(url: string): Promise<void>
    copyText(text: string): Promise<void>
    onCommand(listener: (command: AppCommand) => void): Unsubscribe
    /** The third-party notices shipped with the app */
    openLicenses(): Promise<void>
    /** Errors of the page, written to main's log */
    log(level: 'warn' | 'error', message: string): void
    /**
     * From the tray panel: show the main window and pass it a command (select a
     * project, open the settings)
     */
    showMainWindow(command?: AppCommand): void
    /** From the tray panel: quit, also when the app keeps running in the notification area */
    quit(): void
    /** Window controls drawn by the app on macOS/Linux when needed */
    window: {
      minimize(): void
      toggleMaximize(): void
      close(): void
      onFocusChanged(listener: (focused: boolean) => void): Unsubscribe
    }
  }
}

declare global {
  interface Window {
    desktop: DesktopApi
  }
}
