/**
 * IPC handlers behind `window.desktop`: one per channel (a missing one does
 * not compile), each answering with the type the preload promises. Only the
 * app's own windows are answered, and every argument coming from the
 * renderer is checked before use (`validate.ts`).
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, IpcMainEvent, IpcMainInvokeEvent, shell } from 'electron'
import path from 'path'
import { AppCommand, DesktopApi } from '../shared/desktop-api'
import { EVENTS, INVOKE, SEND } from '../shared/ipc-channels'
import { AppSettings, AppStatus } from '../shared/models'
import { log } from './log'
import { ProjectService } from './projects'
import { isTrustedSender, openExternal } from './security'
import { AppStore } from './store'
import { checkForUpdates, versionInfo } from './updates'
import {
  activityLimit,
  appCommand,
  folderPath,
  isRecord,
  LIMITS,
  newProjectInput,
  optionalFolder,
  optionalProjectId,
  pageQuery,
  projectId,
  projectPatch,
  settingsPatch,
  text,
} from './validate'

export interface IpcDeps {
  projects: ProjectService
  store: AppStore
  status: () => AppStatus
  applySettings: (next: AppSettings, previous: AppSettings) => void
  /** To every window of the app */
  broadcast: (channel: string, ...args: unknown[]) => void
  showMainWindow: (command?: AppCommand) => void
  quit: () => void
}

type Api = DesktopApi
/** What a call of `window.desktop` resolves to */
type Answer<F> = F extends (...args: never[]) => Promise<infer R> ? R : never

interface Answers {
  [INVOKE.projectsList]: Answer<Api['projects']['list']>
  [INVOKE.projectsCreate]: Answer<Api['projects']['create']>
  [INVOKE.projectsUpdate]: Answer<Api['projects']['update']>
  [INVOKE.projectsRemove]: Answer<Api['projects']['remove']>
  [INVOKE.projectsRevealToken]: Answer<Api['projects']['revealToken']>
  [INVOKE.syncSync]: Answer<Api['sync']['sync']>
  [INVOKE.syncSyncAll]: Answer<Api['sync']['syncAll']>
  [INVOKE.syncDownload]: Answer<Api['sync']['download']>
  [INVOKE.syncRetryFailed]: Answer<Api['sync']['retryFailed']>
  [INVOKE.syncConfirmCleanup]: Answer<Api['sync']['confirmCleanup']>
  [INVOKE.syncStop]: Answer<Api['sync']['stop']>
  [INVOKE.syncGetActivity]: Answer<Api['sync']['getActivity']>
  [INVOKE.syncGetFailed]: Answer<Api['sync']['getFailed']>
  [INVOKE.syncGetDuplicates]: Answer<Api['sync']['getDuplicates']>
  [INVOKE.foldersPick]: Answer<Api['folders']['pick']>
  [INVOKE.foldersInspect]: Answer<Api['folders']['inspect']>
  [INVOKE.foldersOpenProject]: Answer<Api['folders']['openProject']>
  [INVOKE.tokensVerify]: Answer<Api['tokens']['verify']>
  [INVOKE.tokensVerifyProject]: Answer<Api['tokens']['verifyProject']>
  [INVOKE.settingsGet]: Answer<Api['settings']['get']>
  [INVOKE.settingsSet]: Answer<Api['settings']['set']>
  [INVOKE.appVersion]: Answer<Api['app']['version']>
  [INVOKE.appCheckForUpdates]: Answer<Api['app']['checkForUpdates']>
  [INVOKE.appStatus]: Answer<Api['app']['status']>
  [INVOKE.appOpenExternal]: Answer<Api['app']['openExternal']>
  [INVOKE.appCopyText]: Answer<Api['app']['copyText']>
  [INVOKE.appOpenLicenses]: Answer<Api['app']['openLicenses']>
}

type InvokeChannel = (typeof INVOKE)[keyof typeof INVOKE]
type SendChannel = (typeof SEND)[keyof typeof SEND]
/** Arguments are whatever the page sent: unknown until checked */
type Handlers = {
  [K in InvokeChannel]: (event: IpcMainInvokeEvent, ...args: unknown[]) => Answers[K] | Promise<Answers[K]>
}
type Listeners = { [K in SendChannel]: (event: IpcMainEvent, ...args: unknown[]) => void }

/** The third-party notices: shipped next to the app (extraResources), generated in the repository in development */
function licensesFile(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'THIRD_PARTY_NOTICES.txt')
    : path.resolve('THIRD_PARTY_NOTICES.txt')
}

export function registerIpc(deps: IpcDeps): void {
  const { projects, store } = deps

  const handlers: Handlers = {
    [INVOKE.projectsList]: () => projects.views(),
    [INVOKE.projectsCreate]: (_e, input) => projects.create(newProjectInput(input)),
    [INVOKE.projectsUpdate]: (_e, id, patch) => projects.update(projectId(id), projectPatch(patch)),
    [INVOKE.projectsRemove]: (_e, id, options) =>
      projects.remove(projectId(id), { delete_files: isRecord(options) && options.delete_files === true }),
    [INVOKE.projectsRevealToken]: (_e, id) => projects.revealToken(projectId(id)),

    [INVOKE.syncSync]: (_e, id, options) =>
      projects.startJob(projectId(id), 'sync', { full_listing: isRecord(options) && options.full_listing === true }),
    [INVOKE.syncSyncAll]: () => projects.syncAll(),
    [INVOKE.syncDownload]: (_e, id) => projects.startJob(projectId(id), 'download'),
    [INVOKE.syncRetryFailed]: (_e, id) => projects.startJob(projectId(id), 'retry_failed'),
    [INVOKE.syncConfirmCleanup]: (_e, id) => projects.startJob(projectId(id), 'cleanup'),
    [INVOKE.syncStop]: (_e, id) => projects.stop(projectId(id)),
    [INVOKE.syncGetActivity]: (_e, id, limit) => projects.getActivity(projectId(id), activityLimit(limit)),
    [INVOKE.syncGetFailed]: (_e, id, page) => projects.getFailed(projectId(id), pageQuery(page)),
    [INVOKE.syncGetDuplicates]: (_e, id, page) => projects.getDuplicates(projectId(id), pageQuery(page)),

    [INVOKE.foldersPick]: async (event, default_path) => {
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const options: Electron.OpenDialogOptions = {
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: optionalFolder(default_path),
      }
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return result.canceled ? undefined : result.filePaths[0]
    },
    [INVOKE.foldersInspect]: (_e, folder, id) => projects.inspect(folderPath(folder), optionalProjectId(id)),
    [INVOKE.foldersOpenProject]: (_e, id) => projects.openFolder(projectId(id)),

    [INVOKE.tokensVerify]: (_e, token) => projects.verifyToken(text(token, LIMITS.token)),
    [INVOKE.tokensVerifyProject]: (_e, id) => projects.verifyProjectToken(projectId(id)),

    [INVOKE.settingsGet]: () => store.settings,
    [INVOKE.settingsSet]: (_e, patch) => {
      const previous = store.settings
      const next = store.setSettings(settingsPatch(patch))
      deps.applySettings(next, previous)
      return next
    },

    [INVOKE.appVersion]: () => versionInfo(),
    [INVOKE.appCheckForUpdates]: async () => {
      const version = await checkForUpdates()
      deps.broadcast(EVENTS.appVersion, version)
      return version
    },
    [INVOKE.appStatus]: () => deps.status(),
    [INVOKE.appOpenExternal]: (_e, url) => openExternal(url),
    [INVOKE.appCopyText]: (_e, value) => clipboard.writeText(text(value, LIMITS.text)),
    [INVOKE.appOpenLicenses]: async () => {
      const error = await shell.openPath(licensesFile())
      if (error) throw new Error('open_failed')
    },
  }

  const listeners: Listeners = {
    [SEND.log]: (_e, level, message) =>
      log(level == 'warn' ? 'warn' : 'error', `renderer: ${String(message).slice(0, LIMITS.log)}`),
    [SEND.showMainWindow]: (_e, command) => deps.showMainWindow(appCommand(command)),
    [SEND.quit]: () => deps.quit(),
    [SEND.windowMinimize]: event => BrowserWindow.fromWebContents(event.sender)?.minimize(),
    [SEND.windowToggleMaximize]: event => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    },
    [SEND.windowClose]: event => BrowserWindow.fromWebContents(event.sender)?.close(),
  }

  for (const channel of Object.keys(handlers) as InvokeChannel[]) {
    const handler = handlers[channel] as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!isTrustedSender(event)) {
        log('warn', `IPC ${channel} refused: not from a window of the app`)
        throw new Error('forbidden')
      }
      return handler(event, ...args)
    })
  }
  for (const channel of Object.keys(listeners) as SendChannel[]) {
    const listener = listeners[channel]
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      if (isTrustedSender(event)) listener(event, ...args)
      else log('warn', `IPC ${channel} ignored: not from a window of the app`)
    })
  }
}
