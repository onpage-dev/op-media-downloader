/**
 * App store: settings, projects (tokens encrypted with safeStorage), the last
 * known state of each project and the window bounds. Same file as 1.x
 * (`op-media-downloader-config.json`), migrated on first start.
 */
import { safeStorage } from 'electron'
import Store from 'electron-store'
import {
  AppLanguage,
  AppSettings,
  DEFAULT_SETTINGS,
  FolderInfo,
  Issue,
  PlanSummary,
  ProjectConfig,
  ProjectId,
  SyncResult,
} from '../shared/models'
import { log } from './log'

export interface StoredProject extends ProjectConfig {
  /** safeStorage.encryptString, base64 */
  token_enc?: string
  /** Only where the OS offers no encryption (some Linux setups) */
  token_plain?: string
  last_result?: SyncResult
  plan?: PlanSummary
  /** Issues still valid after a restart (failed files, duplicates, copies) */
  issues?: Issue[]
  folder_info?: FolderInfo
}

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

interface StoreSchema {
  version: number
  settings: AppSettings
  projects: Record<ProjectId, StoredProject>
  window_state?: WindowState
}

/** 1.x shapes, read once by the migration */
interface V1Project {
  id: string
  label: string
  api_token: string
  folder_path: string
  keep_old_files: boolean
  last_sync?: {
    start_time: string
    end_time: string
    downloaded: number
    failed: number
    already_exists: number
    total: number
  }
}
interface V1UserProperties {
  dark_mode?: boolean
  simultaneous_downloads?: number
  language?: 'it' | 'en'
}

const STORE_VERSION = 2

export class AppStore {
  private store = new Store<StoreSchema>({
    name: 'op-media-downloader-config',
    clearInvalidConfig: false,
  })

  /** default_language: the language of a new install, the system's one */
  constructor(private readonly default_language: AppLanguage = DEFAULT_SETTINGS.language) {
    this.migrate()
  }

  /* ---------------------------------------------------------------- settings */

  get settings(): AppSettings {
    return { ...DEFAULT_SETTINGS, ...(this.store.get('settings') ?? {}) }
  }

  setSettings(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.settings, ...patch }
    next.concurrency = Math.min(10, Math.max(1, Math.round(next.concurrency)))
    this.store.set('settings', next)
    return next
  }

  /* ---------------------------------------------------------------- projects */

  get projects(): StoredProject[] {
    return Object.values(this.store.get('projects') ?? {}).sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    )
  }

  project(id: ProjectId): StoredProject | undefined {
    return this.store.get('projects')?.[id]
  }

  saveProject(project: StoredProject): void {
    this.store.set(`projects.${project.id}`, project)
  }

  patchProject(id: ProjectId, patch: Partial<StoredProject>): StoredProject | undefined {
    const current = this.project(id)
    if (!current) return undefined
    const next = { ...current, ...patch }
    this.saveProject(next)
    return next
  }

  removeProject(id: ProjectId): void {
    this.store.delete(`projects.${id}` as keyof StoreSchema)
  }

  /* ---------------------------------------------------------------- tokens */

  encryptToken(token: string): Pick<StoredProject, 'token_enc' | 'token_plain'> {
    if (safeStorage.isEncryptionAvailable()) {
      return { token_enc: safeStorage.encryptString(token).toString('base64'), token_plain: undefined }
    }
    return { token_enc: undefined, token_plain: token }
  }

  token(project: StoredProject): string {
    if (project.token_enc) {
      try {
        return safeStorage.decryptString(Buffer.from(project.token_enc, 'base64'))
      } catch (error) {
        log('error', `Cannot decrypt the token of project ${project.id}`, error)
        return ''
      }
    }
    return project.token_plain ?? ''
  }

  /* ---------------------------------------------------------------- window */

  get windowState(): WindowState | undefined {
    return this.store.get('window_state')
  }

  set windowState(state: WindowState) {
    this.store.set('window_state', state)
  }

  /* ---------------------------------------------------------------- migration */

  private migrate(): void {
    const version = this.store.get('version') ?? 0
    if (version >= STORE_VERSION) return

    const raw = this.store.store as unknown as Record<string, unknown>
    const v1_projects = (raw['storage_data'] ?? {}) as Record<string, V1Project>
    const v1_user = (raw['user_properties'] ?? {}) as V1UserProperties

    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      theme: v1_user.dark_mode ? 'dark' : 'system',
      /** 1.x showed Italian unless told otherwise */
      language: v1_user.language ?? ('storage_data' in raw || 'user_properties' in raw ? 'it' : this.default_language),
      /** 1 was the 1.x default, not a choice: start from the 2.0 default */
      concurrency:
        v1_user.simultaneous_downloads && v1_user.simultaneous_downloads > 1
          ? v1_user.simultaneous_downloads
          : DEFAULT_SETTINGS.concurrency,
    }

    const projects: Record<ProjectId, StoredProject> = {}
    for (const v1 of Object.values(v1_projects)) {
      if (!v1?.id) continue
      projects[v1.id] = {
        id: v1.id,
        label: v1.label,
        folder: v1.folder_path,
        keep_old_files: !!v1.keep_old_files,
        created_at: new Date().toISOString(),
        ...this.encryptToken(v1.api_token ?? ''),
        last_result: v1.last_sync ? fromV1Sync(v1.last_sync) : undefined,
      }
    }

    this.store.set('settings', settings)
    this.store.set('projects', projects)
    this.store.set('version', STORE_VERSION)
    /** The 1.x keys held the tokens in clear: they go */
    this.store.delete('storage_data' as keyof StoreSchema)
    this.store.delete('user_properties' as keyof StoreSchema)
    log('info', `Store migrated to v${STORE_VERSION}: ${Object.keys(projects).length} projects`)
  }
}

function fromV1Sync(sync: NonNullable<V1Project['last_sync']>): SyncResult {
  return {
    job: 'download',
    started_at: v1Date(sync.start_time),
    ended_at: v1Date(sync.end_time),
    outcome: 'completed',
    total: sync.total ?? 0,
    downloaded: sync.downloaded ?? 0,
    linked: 0,
    removed: 0,
    already_present: sync.already_exists ?? 0,
    failed: sync.failed ?? 0,
    bytes: 0,
  }
}

/** 1.x saved local times as `YYYY-MM-DD HH:mm:ss` */
function v1Date(value: string): string {
  const date = new Date(value?.replace(' ', 'T'))
  return isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}
