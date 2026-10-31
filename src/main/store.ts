/**
 * App store: settings, projects (tokens encrypted with safeStorage), the last
 * known state of each project and the window bounds. Same file as 1.x
 * (`op-media-downloader-config.json`), migrated on first start.
 *
 * Main is the only writer, so reads come from electron-store's cache, which
 * is frozen: never change a value a read returned, write a new one. Every
 * value read back is checked (a hand-edited or half-written file must not
 * break the app), and a file that cannot be parsed is set aside: the app
 * starts without projects and tells the user where the old file is.
 */
import crypto from 'crypto'
import { app, safeStorage } from 'electron'
import Store from 'electron-store'
import fs from 'fs'
import path from 'path'
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
import { cleanSettings, concurrency, isLanguage, isProjectId, isRecord } from './validate'

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
  /** StoredProject by id, as far as the file can be trusted: each one is checked when read */
  projects: Record<ProjectId, unknown>
  window_state?: WindowState
}

export interface AppStoreOptions {
  /** The language of a new install: the system's one */
  default_language?: AppLanguage
  /** The folder of the file, userData when missing (tests use a temporary one) */
  cwd?: string
}

const STORE_NAME = 'op-media-downloader-config'
const STORE_VERSION = 2
/** The 1.x keys: `storage_data` held the projects with their tokens in clear, `user_properties` the settings */
const V1_KEYS = ['storage_data', 'user_properties'] as const
/** created_at of a project saved without one */
const EPOCH = new Date(0).toISOString()

export class AppStore {
  private store: Store<StoreSchema>
  private readonly default_language: AppLanguage
  /** Whether each encrypted token decrypts here to a token (another user's or computer's does not) */
  private token_ok = new Map<string, boolean>()
  /** Where a config file that could not be parsed was set aside, to tell the user */
  readonly set_aside?: string

  constructor(options: AppStoreOptions = {}) {
    this.default_language = options.default_language ?? DEFAULT_SETTINGS.language
    const opened = openStore(options.cwd)
    this.store = opened.store
    this.set_aside = opened.set_aside
    this.migrate()
    this.encryptPlainTokens()
  }

  /* ---------------------------------------------------------------- settings */

  get settings(): AppSettings {
    return cleanSettings(this.store.get('settings'), { ...DEFAULT_SETTINGS, language: this.default_language })
  }

  setSettings(patch: Partial<AppSettings>): AppSettings {
    const current = this.settings
    const next = cleanSettings({ ...current, ...patch }, current)
    this.store.set('settings', next)
    return next
  }

  /* ---------------------------------------------------------------- projects */

  get projects(): StoredProject[] {
    return Object.entries(this.projectMap())
      .map(([id, value]) => readProject(id, value))
      .filter((project): project is StoredProject => !!project)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
  }

  /** Only a project of the file: `constructor` or `__proto__` are not projects */
  project(id: ProjectId): StoredProject | undefined {
    const projects = this.projectMap()
    return Object.hasOwn(projects, id) ? readProject(id, projects[id]) : undefined
  }

  saveProject(project: StoredProject): void {
    if (!isProjectId(project.id)) throw new Error('invalid_input')
    this.store.set('projects', { ...this.projectMap(), [project.id]: project })
  }

  patchProject(id: ProjectId, patch: Partial<StoredProject>): StoredProject | undefined {
    const current = this.project(id)
    if (!current) return undefined
    const next = { ...current, ...patch, id }
    this.saveProject(next)
    return next
  }

  removeProject(id: ProjectId): void {
    const projects = this.projectMap()
    if (!Object.hasOwn(projects, id)) return
    this.store.set('projects', Object.fromEntries(Object.entries(projects).filter(([key]) => key != id)))
  }

  /** The projects as the file has them (whole objects only: one entry per id) */
  private projectMap(): Record<string, unknown> {
    const projects: unknown = this.store.get('projects')
    return isRecord(projects) ? projects : {}
  }

  /* ---------------------------------------------------------------- tokens */

  encryptToken(token: string): Pick<StoredProject, 'token_enc' | 'token_plain'> {
    if (safeStorage.isEncryptionAvailable()) {
      return { token_enc: safeStorage.encryptString(token).toString('base64'), token_plain: undefined }
    }
    return { token_enc: undefined, token_plain: token }
  }

  /** The token in clear; empty when there is none or it cannot be decrypted here */
  token(project: StoredProject): string {
    if (project.token_enc) return this.decrypt(project.token_enc, project.id)
    return project.token_plain ?? ''
  }

  /**
   * A token that cannot be decrypted (the file comes from another user or
   * computer) does not count: the page asks for a new one
   */
  hasToken(project: StoredProject): boolean {
    if (!project.token_enc) return !!project.token_plain
    return this.token_ok.get(project.token_enc) ?? !!this.decrypt(project.token_enc, project.id)
  }

  private decrypt(token_enc: string, id: ProjectId): string {
    try {
      const token = safeStorage.decryptString(Buffer.from(token_enc, 'base64'))
      this.token_ok.set(token_enc, !!token)
      return token
    } catch (error) {
      if (!this.token_ok.has(token_enc)) log('error', `Cannot decrypt the token of project ${id}`, error)
      this.token_ok.set(token_enc, false)
      return ''
    }
  }

  /** Tokens saved in clear because the OS had no encryption are encrypted once it has (one write) */
  private encryptPlainTokens(): void {
    if (!safeStorage.isEncryptionAvailable()) return
    const projects = this.projectMap()
    const next: Record<string, unknown> = { ...projects }
    let count = 0
    for (const [id, value] of Object.entries(projects)) {
      const project = readProject(id, value)
      if (!project?.token_plain || project.token_enc) continue
      next[id] = { ...project, ...this.encryptToken(project.token_plain) }
      count++
    }
    if (!count) return
    this.store.set('projects', next)
    log('info', `Tokens of ${count} projects encrypted`)
  }

  /* ---------------------------------------------------------------- window */

  get windowState(): WindowState | undefined {
    const state: unknown = this.store.get('window_state')
    if (!isRecord(state) || !isFiniteNumber(state.width) || !isFiniteNumber(state.height)) return undefined
    return {
      x: isFiniteNumber(state.x) ? state.x : undefined,
      y: isFiniteNumber(state.y) ? state.y : undefined,
      width: state.width,
      height: state.height,
      maximized: state.maximized === true,
    }
  }

  set windowState(state: WindowState) {
    this.store.set('window_state', state)
  }

  /* ---------------------------------------------------------------- migration */

  /**
   * 1.x → 2.0 in one write: settings, projects (tokens encrypted), version.
   * The 1.x keys go whenever they are there (1.x run again after the
   * migration writes them anew): projects 1.x added meanwhile are kept.
   */
  private migrate(): void {
    const raw: Record<string, unknown> = { ...this.store.store }
    const version = typeof raw.version == 'number' ? raw.version : 0
    const has_v1 = V1_KEYS.some(key => Object.hasOwn(raw, key))
    if (version >= STORE_VERSION && !has_v1) return

    const projects: Record<string, unknown> = isRecord(raw.projects) ? { ...raw.projects } : {}
    const folders = new Set(
      Object.entries(projects)
        .flatMap(([id, value]) => readProject(id, value)?.folder ?? [])
        .map(folderKey),
    )
    let imported = 0
    for (const project of v1Projects(raw.storage_data, token => this.encryptToken(token))) {
      /** Already migrated (by id or by folder: two projects never share a folder) */
      if (Object.hasOwn(projects, project.id) || folders.has(folderKey(project.folder))) continue
      projects[project.id] = project
      folders.add(folderKey(project.folder))
      imported++
    }

    const next: Record<string, unknown> = { ...raw, projects }
    for (const key of V1_KEYS) delete next[key]
    if (version < STORE_VERSION) {
      next.settings = v1Settings(raw.user_properties, has_v1, this.default_language)
      next.version = STORE_VERSION
    }
    this.store.store = next as unknown as StoreSchema
    log(
      'info',
      version < STORE_VERSION
        ? `Store migrated to v${STORE_VERSION}: ${imported} projects`
        : `1.x keys removed from the store: ${imported} projects imported`,
    )
  }
}

/**
 * The store, or a new one when the file cannot be parsed: the damaged file is
 * kept beside it as `op-media-downloader-config.corrupt-<time>.json`
 */
function openStore(cwd: string | undefined): { store: Store<StoreSchema>; set_aside?: string } {
  const options = { name: STORE_NAME, cwd, clearInvalidConfig: false, cache: true }
  try {
    return { store: new Store<StoreSchema>(options) }
  } catch (error) {
    if ((error as Error | undefined)?.name != 'SyntaxError') throw error
    const file = path.join(cwd ?? app.getPath('userData'), `${STORE_NAME}.json`)
    const set_aside = path.join(
      path.dirname(file),
      `${STORE_NAME}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    )
    log('error', `The config file cannot be parsed: set aside as ${set_aside}`, error)
    try {
      fs.renameSync(file, set_aside)
      return { store: new Store<StoreSchema>(options), set_aside }
    } catch (rename_error) {
      /** A file another program holds cannot be moved: it is copied, and the store starts over it */
      log('warn', 'The damaged config file cannot be moved: copied instead', rename_error)
      fs.copyFileSync(file, set_aside)
      return { store: new Store<StoreSchema>({ ...options, clearInvalidConfig: true }), set_aside }
    }
  }
}

/** A project read back from the file; anything that is not one is left out */
function readProject(id: string, value: unknown): StoredProject | undefined {
  if (!isProjectId(id) || !isRecord(value) || value.id !== id) return undefined
  if (typeof value.label != 'string' || typeof value.folder != 'string') return undefined
  return {
    id,
    label: value.label,
    folder: value.folder,
    keep_old_files: value.keep_old_files === true,
    created_at: typeof value.created_at == 'string' ? value.created_at : EPOCH,
    token_enc: typeof value.token_enc == 'string' && value.token_enc ? value.token_enc : undefined,
    token_plain: typeof value.token_plain == 'string' && value.token_plain ? value.token_plain : undefined,
    last_result:
      isRecord(value.last_result) && typeof value.last_result.ended_at == 'string'
        ? (value.last_result as unknown as SyncResult)
        : undefined,
    plan: isRecord(value.plan) ? (value.plan as unknown as PlanSummary) : undefined,
    issues: Array.isArray(value.issues) ? (value.issues.filter(isIssue) as Issue[]) : undefined,
    folder_info:
      isRecord(value.folder_info) && Array.isArray(value.folder_info.problems)
        ? (value.folder_info as unknown as FolderInfo)
        : undefined,
  }
}

function isIssue(value: unknown): boolean {
  return isRecord(value) && typeof value.code == 'string' && typeof value.at == 'string'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value == 'number' && Number.isFinite(value)
}

/** Folders compared the way the file systems of the platform compare them */
function folderKey(folder: string): string {
  const normalized = path.normalize(folder.trim()).replace(/[\\/]+$/, '')
  return process.platform == 'linux' ? normalized : normalized.toLowerCase()
}

/* -------------------------------------------------------------------- 1.x */

/** 1.x settings (`user_properties`: dark_mode, simultaneous_downloads, language) as 2.0 settings */
function v1Settings(value: unknown, has_v1: boolean, default_language: AppLanguage): AppSettings {
  const v1 = isRecord(value) ? value : {}
  const simultaneous = concurrency(v1.simultaneous_downloads)
  return {
    ...DEFAULT_SETTINGS,
    theme: v1.dark_mode === true ? 'dark' : 'system',
    /** 1.x showed Italian unless told otherwise; a new install speaks the system's language */
    language: isLanguage(v1.language) ? v1.language : has_v1 ? 'it' : default_language,
    /** 1 was the 1.x default, not a choice: start from the 2.0 default */
    concurrency: simultaneous && simultaneous > 1 ? simultaneous : DEFAULT_SETTINGS.concurrency,
  }
}

/** 1.x projects (`storage_data`: id, label, api_token, folder_path, keep_old_files, last_sync) in their order */
function v1Projects(
  value: unknown,
  encrypt: (token: string) => Pick<StoredProject, 'token_enc' | 'token_plain'>,
): StoredProject[] {
  if (!isRecord(value)) return []
  const now = Date.now()
  const projects: StoredProject[] = []
  for (const v1 of Object.values(value)) {
    if (!isRecord(v1) || typeof v1.folder_path != 'string' || !v1.folder_path.trim()) continue
    const token = typeof v1.api_token == 'string' ? v1.api_token.trim() : ''
    const label = typeof v1.label == 'string' && v1.label.trim() ? v1.label.trim() : path.basename(v1.folder_path)
    projects.push({
      id: isProjectId(v1.id) ? v1.id : crypto.randomUUID(),
      label,
      folder: v1.folder_path,
      keep_old_files: v1.keep_old_files === true,
      /** One millisecond apart: the list keeps the order of 1.x */
      created_at: new Date(now + projects.length).toISOString(),
      ...(token ? encrypt(token) : {}),
      last_result: isRecord(v1.last_sync) ? fromV1Sync(v1.last_sync) : undefined,
    })
  }
  return projects
}

function fromV1Sync(sync: Record<string, unknown>): SyncResult {
  const count = (value: unknown): number => (isFiniteNumber(value) && value >= 0 ? Math.floor(value) : 0)
  return {
    job: 'download',
    started_at: v1Date(sync.start_time),
    ended_at: v1Date(sync.end_time),
    outcome: 'completed',
    total: count(sync.total),
    downloaded: count(sync.downloaded),
    linked: 0,
    removed: 0,
    already_present: count(sync.already_exists),
    failed: count(sync.failed),
    bytes: 0,
  }
}

/** 1.x saved local times as `YYYY-MM-DD HH:mm:ss` */
function v1Date(value: unknown): string {
  const date = new Date(typeof value == 'string' ? value.replace(' ', 'T') : NaN)
  return isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}
