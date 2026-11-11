/**
 * `window.desktop` on Tauri: every call is one of the app's commands
 * (`src-tauri/src/commands.rs`, named after the method), every `on…` one of
 * its events. The page reaches nothing else of the system: the capabilities
 * of its windows allow these commands and listening to events only.
 *
 * Commands reject with the app's error code (`project_busy`, `open_failed`…):
 * it becomes the message of an `Error`, as the page expects.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { AppCommand, DesktopApi, FolderDrag, Unsubscribe } from '@shared/desktop-api'
import type { ActivityEntry, ProjectId } from '@shared/models'

/** A command of the app; its rejection is an Error with the app's code */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw new Error(typeof error == 'string' ? error : String((error as Error | undefined)?.message ?? error), {
      cause: error,
    })
  }
}

/**
 * Tauri subscribes asynchronously: the subscription is kept as a promise, so
 * that an unsubscribe that comes before it is in place still ends it
 */
function subscription(start: Promise<UnlistenFn>): Unsubscribe {
  let stopped = false
  let stop: UnlistenFn | undefined
  start.then(
    unlisten => {
      if (stopped) unlisten()
      else stop = unlisten
    },
    (error: unknown) => console.error('subscription', error),
  )
  return () => {
    stopped = true
    stop?.()
  }
}

function on<T>(event: string, listener: (payload: T) => void): Unsubscribe {
  return subscription(listen<T>(event, event => listener(event.payload)))
}

/** The system the page runs on, from the webview's user agent (WebView2, WKWebView, WebKitGTK) */
function platform(): DesktopApi['platform'] {
  const agent = navigator.userAgent
  if (agent.includes('Windows')) return 'win32'
  if (agent.includes('Macintosh') || agent.includes('Mac OS X')) return 'darwin'
  return 'linux'
}

/**
 * Commands from the menus, the tray or a second launch can come before the
 * page listens: the app keeps them until the page asks for them, once its
 * listener is in place
 */
function listenCommands(listener: (command: AppCommand) => void): Unsubscribe {
  let stopped = false
  const listening = listen<AppCommand>('app:command', event => listener(event.payload))
  const stop = subscription(listening)
  void listening
    .then(() => call<AppCommand[]>('app_take_commands'))
    .then(commands => {
      if (!stopped) for (const command of commands) listener(command)
    })
    .catch((error: unknown) => console.error('commands', error))
  return () => {
    stopped = true
    stop()
  }
}

/** The system's drag and drop over the window: the paths of what is dropped */
function listenDrag(listener: (drag: FolderDrag) => void): Unsubscribe {
  return subscription(
    getCurrentWebview().onDragDropEvent(event => {
      const drag = event.payload
      if (drag.type == 'enter' || drag.type == 'over') listener({ type: 'enter' })
      else if (drag.type == 'leave') listener({ type: 'leave' })
      else listener({ type: 'drop', paths: drag.paths })
    }),
  )
}

export const tauriDesktop: DesktopApi = {
  platform: platform(),

  projects: {
    list: () => call('projects_list'),
    create: input => call('projects_create', { input }),
    update: (id, patch) => call('projects_update', { id, patch }),
    remove: (id, options) => call('projects_remove', { id, options }),
    revealToken: id => call('projects_reveal_token', { id }),
    onChanged: listener => on('projects:changed', listener),
  },

  sync: {
    sync: (id, options) => call('sync_sync', { id, options }),
    syncAll: () => call('sync_sync_all'),
    download: id => call('sync_download', { id }),
    retryFailed: id => call('sync_retry_failed', { id }),
    confirmCleanup: id => call('sync_confirm_cleanup', { id }),
    stop: id => call('sync_stop', { id }),
    getActivity: (id, limit) => call('sync_get_activity', { id, limit }),
    onActivity: listener =>
      on<{ project_id: ProjectId; entries: ActivityEntry[] }>('sync:activity', payload =>
        listener(payload.project_id, payload.entries),
      ),
    getFailed: (id, page) => call('sync_get_failed', { id, page }),
    getDuplicates: (id, page) => call('sync_get_duplicates', { id, page }),
  },

  folders: {
    pick: default_path => call('folders_pick', { defaultPath: default_path }),
    inspect: (path, project_id) => call('folders_inspect', { path, projectId: project_id }),
    openProject: id => call('folders_open_project', { id }),
    onDrag: listenDrag,
  },

  tokens: {
    verify: token => call('tokens_verify', { token }),
    verifyProject: id => call('tokens_verify_project', { id }),
  },

  settings: {
    get: () => call('settings_get'),
    set: patch => call('settings_set', { patch }),
    onChanged: listener => on('settings:changed', listener),
  },

  app: {
    version: () => call('app_version'),
    checkForUpdates: () => call('app_check_for_updates'),
    onVersion: listener => on('app:version', listener),
    status: () => call('app_status'),
    onStatus: listener => on('app:status', listener),
    openExternal: url => call('app_open_external', { url }),
    copyText: text => call('app_copy_text', { text }),
    onCommand: listenCommands,
    openLicenses: () => call('app_open_licenses'),
    log: (level, message) => void call('app_log', { level, message }).catch(() => undefined),
    showMainWindow: command => void call('app_show_main_window', { command }).catch(() => undefined),
    quit: () => void call('app_quit').catch(() => undefined),
    window: {
      minimize: () => void call('window_minimize').catch(() => undefined),
      toggleMaximize: () => void call('window_toggle_maximize').catch(() => undefined),
      close: () => void call('window_close').catch(() => undefined),
      onFocusChanged: listener => subscription(getCurrentWindow().onFocusChanged(event => listener(event.payload))),
    },
  },
}

/** The page runs in the app: `window.desktop` is the app */
export function installTauriDesktop(): void {
  window.desktop = tauriDesktop
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}
