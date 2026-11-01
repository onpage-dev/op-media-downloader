/**
 * The only bridge between the sandboxed renderer and the main process:
 * `window.desktop`, typed by `DesktopApi`. No generic `ipcRenderer`.
 */
import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron'
import { DesktopApi, Unsubscribe } from '../shared/desktop-api'
import { EVENTS, INVOKE, SEND } from '../shared/ipc-channels'

function listen<T extends unknown[]>(channel: string, listener: (...args: T) => void): Unsubscribe {
  const handler = (_event: IpcRendererEvent, ...args: unknown[]): void => listener(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

/**
 * Calls to main: a rejection carries only the error code main threw
 * (Electron prefixes "Error invoking remote method '…': Error: ").
 */
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((error: unknown) => {
    const message = String((error as Error | undefined)?.message ?? error)
    throw new Error(message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ''))
  })
}

/**
 * Commands from main (menu, tray, jump list, a second launch) can arrive
 * before the page subscribes: they wait here and reach the first listener.
 */
const early_commands: unknown[] = []
let command_listeners = 0
ipcRenderer.on(EVENTS.appCommand, (_event, command) => {
  if (!command_listeners) early_commands.push(command)
})
function listenCommands(listener: Parameters<DesktopApi['app']['onCommand']>[0]): Unsubscribe {
  command_listeners++
  const stop = listen(EVENTS.appCommand, listener)
  for (const command of early_commands.splice(0)) listener(command as Parameters<typeof listener>[0])
  return () => {
    command_listeners--
    stop()
  }
}

const platform = process.platform as DesktopApi['platform']

const desktop: DesktopApi = {
  platform,

  projects: {
    list: () => invoke(INVOKE.projectsList),
    create: input => invoke(INVOKE.projectsCreate, input),
    update: (id, patch) => invoke(INVOKE.projectsUpdate, id, patch),
    remove: (id, options) => invoke(INVOKE.projectsRemove, id, options),
    revealToken: id => invoke(INVOKE.projectsRevealToken, id),
    onChanged: listener => listen(EVENTS.projectsChanged, listener),
  },

  sync: {
    sync: (id, options) => invoke(INVOKE.syncSync, id, options),
    syncAll: () => invoke(INVOKE.syncSyncAll),
    download: id => invoke(INVOKE.syncDownload, id),
    retryFailed: id => invoke(INVOKE.syncRetryFailed, id),
    confirmCleanup: id => invoke(INVOKE.syncConfirmCleanup, id),
    stop: id => invoke(INVOKE.syncStop, id),
    getActivity: (id, limit) => invoke(INVOKE.syncGetActivity, id, limit),
    onActivity: listener => listen(EVENTS.syncActivity, listener),
    getFailed: (id, page) => invoke(INVOKE.syncGetFailed, id, page),
    getDuplicates: (id, page) => invoke(INVOKE.syncGetDuplicates, id, page),
  },

  folders: {
    pick: default_path => invoke(INVOKE.foldersPick, default_path),
    inspect: (path, project_id) => invoke(INVOKE.foldersInspect, path, project_id),
    openProject: id => invoke(INVOKE.foldersOpenProject, id),
    pathForDroppedFile: file => webUtils.getPathForFile(file),
  },

  tokens: {
    verify: token => invoke(INVOKE.tokensVerify, token),
    verifyProject: id => invoke(INVOKE.tokensVerifyProject, id),
  },

  settings: {
    get: () => invoke(INVOKE.settingsGet),
    set: patch => invoke(INVOKE.settingsSet, patch),
    onChanged: listener => listen(EVENTS.settingsChanged, listener),
  },

  app: {
    version: () => invoke(INVOKE.appVersion),
    checkForUpdates: () => invoke(INVOKE.appCheckForUpdates),
    status: () => invoke(INVOKE.appStatus),
    onStatus: listener => listen(EVENTS.appStatus, listener),
    onVersion: listener => listen(EVENTS.appVersion, listener),
    openExternal: url => invoke(INVOKE.appOpenExternal, url),
    copyText: text => invoke(INVOKE.appCopyText, text),
    onCommand: listener => listenCommands(listener),
    openLicenses: () => invoke(INVOKE.appOpenLicenses),
    log: (level, message) => ipcRenderer.send(SEND.log, level, message),
    showMainWindow: command => ipcRenderer.send(SEND.showMainWindow, command),
    quit: () => ipcRenderer.send(SEND.quit),
    window: {
      minimize: () => ipcRenderer.send(SEND.windowMinimize),
      toggleMaximize: () => ipcRenderer.send(SEND.windowToggleMaximize),
      close: () => ipcRenderer.send(SEND.windowClose),
      onFocusChanged: listener => listen(EVENTS.windowFocus, listener),
    },
  },
}

contextBridge.exposeInMainWorld('desktop', desktop)
