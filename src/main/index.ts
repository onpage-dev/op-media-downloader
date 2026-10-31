/**
 * Main process: one instance, the window, the tray, notifications, taskbar
 * progress and the sync engine, wired together. Anything that fails while the
 * app starts is shown in an error dialog and the app quits: a process without
 * a window must not keep the single-instance lock.
 */
import { app, dialog, nativeTheme, session } from 'electron'
import crypto from 'crypto'
import path from 'path'
import { AppCommand } from '../shared/desktop-api'
import { EVENTS } from '../shared/ipc-channels'
import { AppLanguage, AppSettings } from '../shared/models'
import { StatusController } from './app-status'
import { EngineHost } from './engine-host'
import { systemLanguage, texts } from './i18n'
import { registerIpc } from './ipc'
import { AppLifecycle, watchSecondInstance } from './lifecycle'
import { flushLog, log, logFile } from './log'
import { MainWindow } from './main-window'
import { commandFromArgv, setupJumpList, setupMenu } from './menu'
import { notifyDeleteFailed, notifyResult } from './notifications'
import { ProjectService } from './projects'
import { debuggingRequested, denyPermissions, secureContents } from './security'
import { AppStore } from './store'
import { TrayController } from './tray'
import { checkForUpdates } from './updates'
import { loadRenderer, preloadPath, reloadOnCrash } from './window'

const APP_ID = 'com.onpage.mediadownloader'

/**
 * Development builds never touch the data of the installed app (1.x keeps its
 * projects and tokens there, and 2.0 would migrate them): they get their own
 * folder, or the one in OPMD_USER_DATA.
 */
if (!app.isPackaged) {
  app.setPath('userData', process.env['OPMD_USER_DATA'] || path.join(app.getPath('appData'), 'op-media-downloader-dev'))
}

/**
 * Errors nobody caught are logged and still reported the way Electron does:
 * the monitor leaves its dialog for exceptions in place; a rejection (only a
 * console warning in Electron, silenced by any listener) is printed by log()
 */
process.on('uncaughtExceptionMonitor', error => log('error', 'Uncaught exception', error))
process.on('unhandledRejection', reason => log('error', 'Unhandled rejection', reason))

const debugging = app.isPackaged ? debuggingRequested() : undefined
if (debugging) {
  log('error', `Not started: ${debugging} is not allowed`)
  flushLog()
  app.exit(1)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  const onSecondInstance = watchSecondInstance()
  if (process.platform == 'win32') app.setAppUserModelId(APP_ID)
  app
    .whenReady()
    .then(() => start(onSecondInstance))
    .catch(startFailed)
}

function language(): AppLanguage {
  return systemLanguage([...app.getPreferredSystemLanguages(), app.getLocale()])
}

/** Says why the app cannot start and quits, which releases the single-instance lock */
function startFailed(error: unknown): void {
  log('error', 'Start-up failed', error)
  flushLog()
  try {
    const t = texts(language())
    dialog.showErrorBox(
      t.start_failed_title,
      `${error instanceof Error ? error.message : String(error)}\n\n${t.start_failed_log(logFile())}`,
    )
  } catch {
    dialog.showErrorBox('On Page Media Downloader', String(error))
  } finally {
    app.exit(1)
  }
}

async function start(onSecondInstance: (handler: (argv: string[]) => void) => void): Promise<void> {
  denyPermissions(session.defaultSession)
  const store = new AppStore({ default_language: language() })
  nativeTheme.themeSource = store.settings.theme
  /** Before anything reads a token: the system decrypts them asynchronously */
  await store.unlockTokens()
  const instance_id = crypto.randomUUID()

  const engine: EngineHost = new EngineHost(() => ({
    cache_dir: path.join(app.getPath('userData'), 'cache'),
    project_folders: projects.projectFolders(),
    concurrency: store.settings.concurrency,
    app_version: app.getVersion(),
    instance_id,
    /** Development only: point the engine at a fake On Page server */
    api_domain: app.isPackaged ? undefined : process.env['OPMD_API_DOMAIN'] || undefined,
  }))
  const projects: ProjectService = new ProjectService(store, engine)

  const tray: TrayController = new TrayController({
    preload: preloadPath(),
    loadPanel: panel => {
      secureContents(panel)
      reloadOnCrash(panel, 'tray')
      loadRenderer(panel, 'tray')
    },
    open: () => main_window.show(),
    syncAll: () => projects.syncAll(),
    quit: () => app.quit(),
    labels: () => {
      const t = texts(store.settings.language)
      return { open: t.open, sync_all: t.sync_all, quit: t.quit }
    },
  })

  const main_window: MainWindow = new MainWindow({
    store,
    hidePanel: () => tray.hidePanel(),
    onFocus: window => status.windowFocused(window),
    onClose: (event, window) => lifecycle.onWindowClose(event, window),
  })
  const sendCommand = (command: AppCommand): void => main_window.sendCommand(command)

  /** The main window and the tray panel show the same projects */
  function broadcast(channel: string, ...args: unknown[]): void {
    for (const window of [main_window.current, tray.panelWindow]) {
      if (window) window.webContents.send(channel, ...args)
    }
  }

  const status: StatusController = new StatusController({
    store,
    projects,
    tray,
    window: () => main_window.current,
    broadcast,
  })
  const lifecycle: AppLifecycle = new AppLifecycle({ store, projects, engine, tray, window: main_window })

  function applySettings(next: AppSettings, previous: AppSettings): void {
    if (next.theme != previous.theme) nativeTheme.themeSource = next.theme
    if (next.language != previous.language) {
      setupMenu(next.language, sendCommand)
      setupJumpList(next.language)
      tray.refreshMenu()
    }
    if (next.concurrency != previous.concurrency) projects.configureEngine(next.concurrency)
    if (next.close_to_tray) tray.enable()
    else tray.disable()
    if (next.open_at_login != previous.open_at_login) applyLoginItem(next)
    status.updateTray()
    broadcast(EVENTS.settingsChanged, next)
  }

  /* ------------------------------------------------------------------ wiring */

  projects.onActivity((id, entries) => broadcast(EVENTS.syncActivity, id, entries))
  projects.onResult((view, result) => {
    status.jobEnded(result, main_window.focused)
    notifyResult(store, view, result, (id, tab) => main_window.focusProject(id, tab))
  })
  projects.onDeleteFailed((project, error) =>
    notifyDeleteFailed(store, project.label, String((error as Error | undefined)?.message ?? error).split(':')[0], () =>
      main_window.show(),
    ),
  )

  registerIpc({
    projects,
    store,
    status: () => status.status(),
    applySettings,
    broadcast,
    showMainWindow: command => {
      if (command) sendCommand(command)
      else {
        tray.hidePanel()
        main_window.show()
      }
    },
    quit: () => app.quit(),
  })

  lifecycle.register()
  onSecondInstance(argv => {
    const command = commandFromArgv(argv)
    if (command) sendCommand(command)
    else main_window.show()
  })

  setupMenu(store.settings.language, sendCommand)
  setupJumpList(store.settings.language)
  if (store.settings.close_to_tray) tray.enable()
  applyLoginItem(store.settings)

  status.start()
  engine.start()
  void projects.refreshFolders()

  const start_hidden = process.argv.includes('--hidden') && store.settings.close_to_tray
  if (!start_hidden) main_window.show()

  const command = commandFromArgv(process.argv)
  if (command) sendCommand(command)

  if (store.set_aside) showConfigSetAside(store, store.set_aside)

  if (store.settings.check_updates) {
    setTimeout(() => {
      void checkForUpdates().then(version => broadcast(EVENTS.appVersion, version))
    }, 5_000)
  }

  log('info', `Started ${app.getVersion()} (${process.platform}, Electron ${process.versions.electron})`)
}

function applyLoginItem(settings: AppSettings): void {
  /** In development this would register the bare Electron binary */
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: settings.open_at_login, args: ['--hidden'] })
}

/** The config file could not be parsed: the app started without projects, and says where the old file is */
function showConfigSetAside(store: AppStore, file: string): void {
  const t = texts(store.settings.language)
  void dialog.showMessageBox({
    type: 'warning',
    buttons: [t.ok],
    title: t.config_damaged_title,
    message: t.config_damaged_message,
    detail: t.config_damaged_detail(file),
  })
}
