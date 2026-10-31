/**
 * Main process: one instance, the window, the tray, notifications, taskbar
 * progress and the sync engine, wired together.
 */
import { app, BrowserWindow, dialog, nativeTheme, net, powerSaveBlocker } from 'electron'
import crypto from 'crypto'
import path from 'path'
import { AppCommand, InspectorTab } from '../shared/desktop-api'
import { EVENTS } from '../shared/ipc-channels'
import { AppSettings, AppStatus, ProjectId, ProjectView } from '../shared/models'
import { aggregateTone, projectStatus } from '../shared/status'
import { EngineHost } from './engine-host'
import { systemLanguage, texts } from './i18n'
import { registerIpc } from './ipc'
import { log } from './log'
import { commandFromArgv, setupJumpList, setupMenu } from './menu'
import { notifyResult } from './notifications'
import { ProjectService } from './projects'
import { AppStore } from './store'
import { updateTaskbar } from './taskbar'
import { TrayController } from './tray'
import { checkForUpdates } from './updates'
import { createMainWindow, loadRenderer, preloadPath, secureContents } from './window'

const APP_ID = 'com.onpage.mediadownloader'

/**
 * Development builds never touch the data of the installed app (1.x keeps its
 * projects and tokens there, and 2.0 would migrate them): they get their own
 * folder, or the one in OPMD_USER_DATA.
 */
if (!app.isPackaged) {
  app.setPath('userData', process.env['OPMD_USER_DATA'] || path.join(app.getPath('appData'), 'op-media-downloader-dev'))
}

process.on('uncaughtException', error => log('error', 'Uncaught exception', error))
process.on('unhandledRejection', error => log('error', 'Unhandled rejection', error))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  if (process.platform == 'win32') app.setAppUserModelId(APP_ID)
  app.whenReady().then(start)
}

function start(): void {
  const store = new AppStore(systemLanguage([...app.getPreferredSystemLanguages(), app.getLocale()]))
  const instance_id = crypto.randomUUID()
  let window: BrowserWindow | undefined
  let quitting = false
  let blocker: number | undefined
  /** Red taskbar after an error, until the user looks at the window */
  let show_errors = false
  let online = net.isOnline()
  const pending_commands: AppCommand[] = []

  nativeTheme.themeSource = store.settings.theme

  const engine = new EngineHost(() => ({
    cache_dir: path.join(app.getPath('userData'), 'cache'),
    project_folders: projects.projectFolders(),
    concurrency: store.settings.concurrency,
    app_version: app.getVersion(),
    instance_id,
    /** Development only: point the engine at a fake On Page server */
    api_domain: app.isPackaged ? undefined : process.env['OPMD_API_DOMAIN'] || undefined,
  }))
  const projects = new ProjectService(store, engine)

  const tray = new TrayController({
    preload: preloadPath(),
    loadPanel: panel => {
      secureContents(panel)
      loadRenderer(panel, 'tray')
    },
    open: () => showWindow(),
    syncAll: () => projects.syncAll(),
    quit: () => app.quit(),
    labels: () => {
      const t = texts(store.settings.language)
      return { open: t.open, sync_all: t.sync_all, quit: t.quit }
    },
  })

  /* ------------------------------------------------------------------ windows */

  function windows(): BrowserWindow[] {
    return [window, tray.panelWindow].filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
  }

  function broadcast(channel: string, ...args: unknown[]): void {
    for (const target of windows()) target.webContents.send(channel, ...args)
  }

  function ensureWindow(): BrowserWindow {
    if (window && !window.isDestroyed()) return window
    window = createMainWindow(store)
    const created = window
    created.once('ready-to-show', () => {
      created.show()
      for (const command of pending_commands.splice(0)) created.webContents.send(EVENTS.appCommand, command)
    })
    created.on('focus', () => {
      show_errors = false
      updateTaskbar(created, projects.views(), show_errors)
      created.webContents.send(EVENTS.windowFocus, true)
    })
    created.on('blur', () => created.webContents.send(EVENTS.windowFocus, false))
    created.on('close', event => onClose(event, created))
    created.on('closed', () => {
      if (window == created) window = undefined
    })
    created.webContents.on('render-process-gone', (_event, details) =>
      log('error', `Renderer gone: ${details.reason}`),
    )
    return created
  }

  function showWindow(): BrowserWindow {
    const target = ensureWindow()
    if (target.isMinimized()) target.restore()
    if (target.webContents.isLoading()) return target
    target.show()
    target.focus()
    return target
  }

  function sendCommand(command: AppCommand): void {
    tray.hidePanel()
    const target = showWindow()
    if (target.webContents.isLoading()) pending_commands.push(command)
    else target.webContents.send(EVENTS.appCommand, command)
  }

  function focusProject(id: ProjectId, tab?: InspectorTab): void {
    sendCommand({ type: 'select_project', project_id: id, tab })
  }

  /* ------------------------------------------------------------------ closing */

  function onClose(event: Electron.Event, target: BrowserWindow): void {
    if (quitting) return
    if (store.settings.close_to_tray && tray.enabled) {
      event.preventDefault()
      target.hide()
      return
    }
    /** On macOS the app stays in the Dock and the engine keeps working */
    if (process.platform == 'darwin') return
    if (projects.isRunning()) {
      event.preventDefault()
      void confirmQuit()
    }
  }

  async function confirmQuit(): Promise<void> {
    const t = texts(store.settings.language)
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: [t.quit_confirm, t.cancel],
      defaultId: 1,
      cancelId: 1,
      title: t.quit_title,
      message: t.quit_title,
      detail: t.quit_message,
    }
    const parent = window && !window.isDestroyed() ? window : undefined
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (response != 0) return
    quitting = true
    await projects.stopAll()
    app.quit()
  }

  app.on('before-quit', event => {
    if (quitting) return
    if (projects.isRunning()) {
      event.preventDefault()
      void confirmQuit()
      return
    }
    quitting = true
  })

  app.on('will-quit', () => {
    engine.dispose()
    tray.disable()
  })

  app.on('window-all-closed', () => {
    if (process.platform != 'darwin' && !(store.settings.close_to_tray && tray.enabled)) app.quit()
  })

  app.on('activate', () => showWindow())

  app.on('second-instance', (_event, argv) => {
    const command = commandFromArgv(argv)
    if (command) sendCommand(command)
    else showWindow()
  })

  /* ------------------------------------------------------------------ state */

  function status(): AppStatus {
    return projects.status(online)
  }

  let status_timer: NodeJS.Timeout | undefined
  function broadcastStatus(): void {
    if (status_timer) return
    status_timer = setTimeout(() => {
      status_timer = undefined
      broadcast(EVENTS.appStatus, status())
    }, 250)
  }

  function onProjects(views: ProjectView[]): void {
    broadcast(EVENTS.projectsChanged, views)
    updateTaskbar(window, views, show_errors)
    updateTray(views)
    updatePowerBlocker()
    broadcastStatus()
  }

  function updateTray(views: ProjectView[]): void {
    const t = texts(store.settings.language)
    const running = views.filter(view => view.runtime.phase != 'idle').length
    const attention = views.filter(view => ['danger', 'warning'].includes(projectStatus(view).tone)).length
    const tooltip = [t.app_name, running ? t.tray_running(running) : attention ? t.tray_attention(attention) : t.tray_idle].join('\n')
    const tone = aggregateTone(views)
    tray.update(tone == 'success' ? undefined : tone, tooltip)
  }

  function updatePowerBlocker(): void {
    const running = projects.isRunning()
    if (running && blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension')
    if (!running && blocker !== undefined) {
      powerSaveBlocker.stop(blocker)
      blocker = undefined
    }
  }

  function applySettings(next: AppSettings, previous: AppSettings): void {
    if (next.theme != previous.theme) nativeTheme.themeSource = next.theme
    if (next.language != previous.language) {
      setupMenu(next.language, sendCommand)
      setupJumpList(next.language)
      updateTray(projects.views())
    }
    if (next.concurrency != previous.concurrency) projects.configureEngine(next.concurrency)
    if (next.close_to_tray) tray.enable()
    else tray.disable()
    if (next.open_at_login != previous.open_at_login) applyLoginItem(next)
    updateTray(projects.views())
    broadcast(EVENTS.settingsChanged, next)
  }

  function applyLoginItem(settings: AppSettings): void {
    /** In development this would register the bare Electron binary */
    if (!app.isPackaged) return
    app.setLoginItemSettings({ openAtLogin: settings.open_at_login, args: ['--hidden'] })
  }

  /* ------------------------------------------------------------------ wiring */

  projects.onChanged(onProjects)
  projects.onActivity((id, entries) => broadcast(EVENTS.syncActivity, id, entries))
  projects.onResult((view, result) => {
    if (result.outcome == 'failed' && !(window?.isFocused() ?? false)) show_errors = true
    notifyResult(store, view, result, focusProject)
  })

  registerIpc({
    projects,
    store,
    status,
    applySettings,
    /** Menus, tray and shortcuts send commands the renderer applies to its selection */
    setSelection: () => undefined,
    showMainWindow: command => {
      if (command) sendCommand(command)
      else {
        tray.hidePanel()
        showWindow()
      }
    },
    quit: () => app.quit(),
  })

  setupMenu(store.settings.language, sendCommand)
  setupJumpList(store.settings.language)
  if (store.settings.close_to_tray) tray.enable()
  applyLoginItem(store.settings)

  engine.start()
  void projects.refreshFolders()

  setInterval(() => {
    const now = net.isOnline()
    if (now != online) {
      online = now
      broadcastStatus()
    }
  }, 10_000)

  const start_hidden = process.argv.includes('--hidden') && store.settings.close_to_tray
  if (!start_hidden) showWindow()

  const command = commandFromArgv(process.argv)
  if (command) sendCommand(command)

  if (store.settings.check_updates) {
    setTimeout(() => {
      void checkForUpdates().then(() => broadcastStatus())
    }, 5_000)
  }

  log('info', `Started ${app.getVersion()} (${process.platform}, Electron ${process.versions.electron})`)
}
