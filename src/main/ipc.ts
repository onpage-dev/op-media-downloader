/**
 * IPC handlers behind `window.desktop`. Every argument coming from the
 * renderer is checked before use.
 */
import { BrowserWindow, clipboard, dialog, ipcMain, IpcMainEvent, IpcMainInvokeEvent, shell } from 'electron'
import { DeleteProjectOptions, NewProjectInput, ProjectPatch } from '../shared/desktop-api'
import { INVOKE, SEND } from '../shared/ipc-channels'
import { AppLanguage, AppSettings, AppStatus, ProjectId, ThemeSetting } from '../shared/models'
import { ProjectService } from './projects'
import { AppStore } from './store'
import { checkForUpdates, versionInfo } from './updates'

export interface IpcDeps {
  projects: ProjectService
  store: AppStore
  status: () => AppStatus
  applySettings: (next: AppSettings, previous: AppSettings) => void
  setSelection: (id: ProjectId | undefined) => void
}

export function registerIpc(deps: IpcDeps): void {
  const { projects, store } = deps
  const handle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void => {
    ipcMain.handle(channel, handler)
  }

  handle(INVOKE.projectsList, () => projects.views())
  handle(INVOKE.projectsCreate, (_e, input: NewProjectInput) => projects.create(newProjectInput(input)))
  handle(INVOKE.projectsUpdate, (_e, id, patch: ProjectPatch) => projects.update(text(id), projectPatch(patch)))
  handle(INVOKE.projectsRemove, (_e, id, options: DeleteProjectOptions) =>
    projects.remove(text(id), { delete_files: options?.delete_files === true }),
  )
  handle(INVOKE.projectsRevealToken, (_e, id) => projects.revealToken(text(id)))

  handle(INVOKE.syncSync, (_e, id, options?: { full_listing?: boolean }) =>
    projects.sync(text(id), options?.full_listing === true),
  )
  handle(INVOKE.syncSyncAll, () => projects.syncAll())
  handle(INVOKE.syncDownload, (_e, id) => projects.download(text(id)))
  handle(INVOKE.syncRetryFailed, (_e, id) => projects.retryFailed(text(id)))
  handle(INVOKE.syncConfirmCleanup, (_e, id) => projects.confirmCleanup(text(id)))
  handle(INVOKE.syncStop, (_e, id) => projects.stop(text(id)))
  handle(INVOKE.syncGetActivity, (_e, id, limit) =>
    projects.getActivity(text(id), typeof limit == 'number' ? limit : undefined),
  )
  handle(INVOKE.syncGetFailed, (_e, id) => projects.getFailed(text(id)))
  handle(INVOKE.syncGetDuplicates, (_e, id) => projects.getDuplicates(text(id)))

  handle(INVOKE.foldersPick, async (event, default_path) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: typeof default_path == 'string' && default_path ? default_path : undefined,
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? undefined : result.filePaths[0]
  })
  handle(INVOKE.foldersInspect, (_e, path, project_id) =>
    projects.inspect(text(path), typeof project_id == 'string' ? project_id : undefined),
  )
  handle(INVOKE.foldersOpen, async (_e, path) => {
    const error = await shell.openPath(text(path))
    if (error) throw new Error(`open_failed:${error}`)
  })

  handle(INVOKE.tokensVerify, (_e, token) => projects.verifyToken(text(token)))

  handle(INVOKE.settingsGet, () => store.settings)
  handle(INVOKE.settingsSet, (_e, patch) => {
    const previous = store.settings
    const next = store.setSettings(settingsPatch(patch))
    deps.applySettings(next, previous)
    return next
  })

  handle(INVOKE.appVersion, () => versionInfo())
  handle(INVOKE.appCheckForUpdates, () => checkForUpdates())
  handle(INVOKE.appStatus, () => deps.status())
  handle(INVOKE.appOpenExternal, async (_e, url) => {
    const value = text(url)
    if (!/^https?:\/\//i.test(value)) throw new Error('invalid_url')
    await shell.openExternal(value)
  })
  handle(INVOKE.appCopyText, (_e, value) => clipboard.writeText(text(value)))

  const on = (channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void => {
    ipcMain.on(channel, listener)
  }
  on(SEND.setSelection, (_e, id) => deps.setSelection(typeof id == 'string' ? id : undefined))
  on(SEND.windowMinimize, event => BrowserWindow.fromWebContents(event.sender)?.minimize())
  on(SEND.windowToggleMaximize, event => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  on(SEND.windowClose, event => BrowserWindow.fromWebContents(event.sender)?.close())
}

/* -------------------------------------------------------------------- input checks */

function text(value: unknown): string {
  if (typeof value != 'string') throw new Error('invalid_input')
  return value
}

function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value)
}

function newProjectInput(input: NewProjectInput): NewProjectInput {
  if (!input || typeof input != 'object') throw new Error('invalid_input')
  return {
    label: text(input.label),
    token: text(input.token),
    folder: text(input.folder),
    keep_old_files: input.keep_old_files === true,
    sync_now: input.sync_now === true,
  }
}

function projectPatch(patch: ProjectPatch): ProjectPatch {
  if (!patch || typeof patch != 'object') throw new Error('invalid_input')
  return {
    label: optionalText(patch.label),
    token: optionalText(patch.token),
    folder: optionalText(patch.folder),
    keep_old_files: typeof patch.keep_old_files == 'boolean' ? patch.keep_old_files : undefined,
  }
}

const THEMES: ThemeSetting[] = ['system', 'light', 'dark']
const LANGUAGES: AppLanguage[] = ['it', 'en']
const FLAGS = ['auto_retry_failed', 'notifications', 'close_to_tray', 'open_at_login', 'check_updates'] as const

function settingsPatch(patch: Partial<AppSettings>): Partial<AppSettings> {
  if (!patch || typeof patch != 'object') throw new Error('invalid_input')
  const clean: Partial<AppSettings> = {}
  if (patch.theme !== undefined && THEMES.includes(patch.theme)) clean.theme = patch.theme
  if (patch.language !== undefined && LANGUAGES.includes(patch.language)) clean.language = patch.language
  if (typeof patch.concurrency == 'number' && Number.isFinite(patch.concurrency)) clean.concurrency = patch.concurrency
  for (const flag of FLAGS) {
    if (typeof patch[flag] == 'boolean') clean[flag] = patch[flag]
  }
  return clean
}
