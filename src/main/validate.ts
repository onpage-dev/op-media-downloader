/**
 * Checks of what reaches main from the renderer (IPC arguments) and from the
 * store (values read back): plain functions without Electron, unit tested.
 * Anything malformed throws `invalid_input`, or is dropped where a default
 * makes sense.
 */
import path from 'path'
import { AppCommand, InspectorTab, NewProjectInput, ProjectPatch, SettingsSection } from '../shared/desktop-api'
import { AppLanguage, AppSettings, LANGUAGES, PageQuery, ProjectId, ThemeSetting } from '../shared/models'

/**
 * Project ids are UUIDs (1.x and 2.0): never a path of the store, nor a name
 * every object has. Names like `toString` still pass: lookups check
 * `Object.hasOwn` as well.
 */
export const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/
const RESERVED_IDS = ['__proto__', 'constructor', 'prototype']

/** Longest strings accepted from the renderer */
export const LIMITS = {
  label: 500,
  token: 2_000,
  path: 4_096,
  query: 200,
  /** Text copied to the clipboard */
  text: 10_000,
  url: 2_048,
  /** A line of the renderer in the log */
  log: 2_000,
} as const

export function invalidInput(): Error {
  return new Error('invalid_input')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value == 'object' && value !== null && !Array.isArray(value)
}

/** value is one of list */
export function oneOf<T>(list: readonly T[], value: unknown): value is T {
  return (list as readonly unknown[]).includes(value)
}

export function isProjectId(value: unknown): value is ProjectId {
  return typeof value == 'string' && PROJECT_ID.test(value) && !RESERVED_IDS.includes(value)
}

export function projectId(value: unknown): ProjectId {
  if (!isProjectId(value)) throw invalidInput()
  return value
}

export function optionalProjectId(value: unknown): ProjectId | undefined {
  return value === undefined || value === null ? undefined : projectId(value)
}

/** A string of at most max characters */
export function text(value: unknown, max: number): string {
  if (typeof value != 'string' || value.length > max) throw invalidInput()
  return value
}

export function optionalText(value: unknown, max: number): string | undefined {
  return value === undefined ? undefined : text(value, max)
}

/** An absolute path: a relative one would be resolved against the working directory of the app */
export function folderPath(value: unknown): string {
  const folder = text(value, LIMITS.path)
  if (folder.includes('\0') || !path.isAbsolute(folder.trim())) throw invalidInput()
  return folder
}

/** A folder to start a picker from: anything but an absolute path is ignored */
export function optionalFolder(value: unknown): string | undefined {
  try {
    return value ? folderPath(value) : undefined
  } catch {
    return undefined
  }
}

/** A page of a long list: at most 200 entries, a query of at most 200 characters */
export function pageQuery(value: unknown): PageQuery {
  const page = isRecord(value) ? value : {}
  const whole = (n: unknown, fallback: number): number =>
    typeof n == 'number' && Number.isFinite(n) ? Math.floor(n) : fallback
  return {
    offset: Math.min(1_000_000_000, Math.max(0, whole(page.offset, 0))),
    limit: Math.min(200, Math.max(1, whole(page.limit, 50))),
    query: typeof page.query == 'string' ? page.query.slice(0, LIMITS.query) : undefined,
  }
}

/** How many activity entries to read: the engine keeps the last 1,000 */
export function activityLimit(value: unknown): number | undefined {
  return typeof value == 'number' && Number.isFinite(value)
    ? Math.min(1_000, Math.max(1, Math.floor(value)))
    : undefined
}

export function newProjectInput(value: unknown): NewProjectInput {
  if (!isRecord(value)) throw invalidInput()
  return {
    label: text(value.label, LIMITS.label),
    token: text(value.token, LIMITS.token),
    folder: folderPath(value.folder),
    keep_old_files: value.keep_old_files === true,
    sync_now: value.sync_now === true,
  }
}

export function projectPatch(value: unknown): ProjectPatch {
  if (!isRecord(value)) throw invalidInput()
  return {
    label: optionalText(value.label, LIMITS.label),
    token: optionalText(value.token, LIMITS.token),
    folder: value.folder === undefined ? undefined : folderPath(value.folder),
    keep_old_files: typeof value.keep_old_files == 'boolean' ? value.keep_old_files : undefined,
  }
}

/* -------------------------------------------------------------------- settings */

export const THEMES: readonly ThemeSetting[] = ['system', 'light', 'dark']
export const SETTING_FLAGS = [
  'auto_retry_failed',
  'notifications',
  'close_to_tray',
  'open_at_login',
  'check_updates',
] as const

export const isTheme = (value: unknown): value is ThemeSetting => oneOf(THEMES, value)
export const isLanguage = (value: unknown): value is AppLanguage => oneOf(LANGUAGES, value)

/** Parallel downloads per project: a number rounded into 1..10, else undefined */
export function concurrency(value: unknown): number | undefined {
  return typeof value == 'number' && Number.isFinite(value) ? Math.min(10, Math.max(1, Math.round(value))) : undefined
}

/** The settings a patch may change, with valid values only */
export function settingsPatch(value: unknown): Partial<AppSettings> {
  if (!isRecord(value)) throw invalidInput()
  const clean: Partial<AppSettings> = {}
  if (isTheme(value.theme)) clean.theme = value.theme
  if (isLanguage(value.language)) clean.language = value.language
  const parallel = concurrency(value.concurrency)
  if (parallel !== undefined) clean.concurrency = parallel
  for (const flag of SETTING_FLAGS) {
    const enabled = value[flag]
    if (typeof enabled == 'boolean') clean[flag] = enabled
  }
  return clean
}

/** Settings read back: each value that is missing or not valid is the fallback's */
export function cleanSettings(value: unknown, fallback: AppSettings): AppSettings {
  const settings = isRecord(value) ? value : {}
  const clean: AppSettings = {
    ...fallback,
    theme: isTheme(settings.theme) ? settings.theme : fallback.theme,
    language: isLanguage(settings.language) ? settings.language : fallback.language,
    concurrency: concurrency(settings.concurrency) ?? fallback.concurrency,
  }
  for (const flag of SETTING_FLAGS) {
    const enabled = settings[flag]
    if (typeof enabled == 'boolean') clean[flag] = enabled
  }
  return clean
}

/* -------------------------------------------------------------------- commands */

const SIMPLE_COMMANDS = [
  'sync_selected',
  'sync_all',
  'download_selected',
  'stop_selected',
  'open_folder_selected',
  'edit_selected',
  'delete_selected',
  'focus_search',
] as const satisfies readonly AppCommand['type'][]
const TABS: readonly InspectorTab[] = ['general', 'activity', 'failed', 'duplicates', 'settings']
const SECTIONS: readonly SettingsSection[] = ['general', 'download', 'appearance', 'language', 'updates']

/** Only well-formed commands reach the main window */
export function appCommand(value: unknown): AppCommand | undefined {
  if (!isRecord(value)) return undefined
  switch (value.type) {
    case 'new_project':
      return { type: 'new_project', folder: optionalFolder(value.folder) }
    case 'select_project':
      if (!isProjectId(value.project_id)) return undefined
      return {
        type: 'select_project',
        project_id: value.project_id,
        tab: oneOf(TABS, value.tab) ? value.tab : undefined,
      }
    case 'open_settings':
      return { type: 'open_settings', section: oneOf(SECTIONS, value.section) ? value.section : undefined }
  }
  return oneOf(SIMPLE_COMMANDS, value.type) ? { type: value.type } : undefined
}

/* -------------------------------------------------------------------- links */

/** github.com (releases), On Page (app.onpage.it and the other subdomains of onpage.it) */
function allowedHost(host: string): boolean {
  return host == 'github.com' || host.endsWith('.onpage.it')
}

/**
 * The address to open in the browser, normalized (`url.href`): https only, to
 * On Page or GitHub, without credentials or another port; else undefined
 */
export function externalUrl(value: unknown): string | undefined {
  if (typeof value != 'string' || value.length > LIMITS.url) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol != 'https:' || url.username || url.password || url.port) return undefined
  return allowedHost(url.hostname) ? url.href : undefined
}
