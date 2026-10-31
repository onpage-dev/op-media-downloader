/**
 * The only bridge between the sandboxed renderer and the main process:
 * `window.desktop`, typed by `DesktopApi`. No generic `ipcRenderer`.
 */
import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron'
import { DesktopApi, Unsubscribe } from '../shared/desktop-api'
import { EVENTS, INVOKE, SEND } from '../shared/ipc-channels'

function listen<T extends unknown[]>(
  channel: string,
  listener: (...args: T) => void,
): Unsubscribe {
  const handler = (_event: IpcRendererEvent, ...args: unknown[]): void =>
    listener(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const platform = process.platform as DesktopApi['platform']

const desktop: DesktopApi = {
  platform,

  projects: {
    list: () => ipcRenderer.invoke(INVOKE.projectsList),
    create: input => ipcRenderer.invoke(INVOKE.projectsCreate, input),
    update: (id, patch) => ipcRenderer.invoke(INVOKE.projectsUpdate, id, patch),
    remove: (id, options) =>
      ipcRenderer.invoke(INVOKE.projectsRemove, id, options),
    revealToken: id => ipcRenderer.invoke(INVOKE.projectsRevealToken, id),
    onChanged: listener => listen(EVENTS.projectsChanged, listener),
  },

  sync: {
    sync: (id, options) => ipcRenderer.invoke(INVOKE.syncSync, id, options),
    syncAll: () => ipcRenderer.invoke(INVOKE.syncSyncAll),
    download: id => ipcRenderer.invoke(INVOKE.syncDownload, id),
    retryFailed: id => ipcRenderer.invoke(INVOKE.syncRetryFailed, id),
    confirmCleanup: id => ipcRenderer.invoke(INVOKE.syncConfirmCleanup, id),
    stop: id => ipcRenderer.invoke(INVOKE.syncStop, id),
    getActivity: (id, limit) =>
      ipcRenderer.invoke(INVOKE.syncGetActivity, id, limit),
    onActivity: listener => listen(EVENTS.syncActivity, listener),
    getFailed: id => ipcRenderer.invoke(INVOKE.syncGetFailed, id),
    getDuplicates: id => ipcRenderer.invoke(INVOKE.syncGetDuplicates, id),
  },

  folders: {
    pick: default_path => ipcRenderer.invoke(INVOKE.foldersPick, default_path),
    inspect: (path, project_id) =>
      ipcRenderer.invoke(INVOKE.foldersInspect, path, project_id),
    open: path => ipcRenderer.invoke(INVOKE.foldersOpen, path),
    pathForDroppedFile: file => webUtils.getPathForFile(file),
  },

  tokens: {
    verify: token => ipcRenderer.invoke(INVOKE.tokensVerify, token),
  },

  settings: {
    get: () => ipcRenderer.invoke(INVOKE.settingsGet),
    set: patch => ipcRenderer.invoke(INVOKE.settingsSet, patch),
    onChanged: listener => listen(EVENTS.settingsChanged, listener),
  },

  app: {
    version: () => ipcRenderer.invoke(INVOKE.appVersion),
    checkForUpdates: () => ipcRenderer.invoke(INVOKE.appCheckForUpdates),
    status: () => ipcRenderer.invoke(INVOKE.appStatus),
    onStatus: listener => listen(EVENTS.appStatus, listener),
    openExternal: url => ipcRenderer.invoke(INVOKE.appOpenExternal, url),
    copyText: text => ipcRenderer.invoke(INVOKE.appCopyText, text),
    onCommand: listener => listen(EVENTS.appCommand, listener),
    setSelection: id => ipcRenderer.send(SEND.setSelection, id),
    window: {
      minimize: () => ipcRenderer.send(SEND.windowMinimize),
      toggleMaximize: () => ipcRenderer.send(SEND.windowToggleMaximize),
      close: () => ipcRenderer.send(SEND.windowClose),
      onFocusChanged: listener => listen(EVENTS.windowFocus, listener),
    },
  },
}

contextBridge.exposeInMainWorld('desktop', desktop)
