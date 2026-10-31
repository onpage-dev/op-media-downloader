/**
 * The life of the app: one instance (a second launch shows the window or
 * passes it its command), the window closing to the tray, quitting confirmed
 * while jobs run or the files of a removed project are being deleted, the
 * Dock on macOS.
 */
import { app, BrowserWindow, dialog } from 'electron'
import { EngineHost } from './engine-host'
import { texts } from './i18n'
import { flushLog } from './log'
import { MainWindow } from './main-window'
import { ProjectService } from './projects'
import { AppStore } from './store'
import { TrayController } from './tray'

/**
 * Listens for second launches as soon as the single-instance lock is taken,
 * before anything that can fail: one that comes while the app starts is
 * handled once the handler is given
 */
export function watchSecondInstance(): (handler: (argv: string[]) => void) => void {
  let handler: ((argv: string[]) => void) | undefined
  const waiting: string[][] = []
  app.on('second-instance', (_event, argv) => {
    if (handler) handler(argv)
    else waiting.push(argv)
  })
  return next => {
    handler = next
    for (const argv of waiting.splice(0)) next(argv)
  }
}

export interface LifecycleDeps {
  store: AppStore
  projects: ProjectService
  engine: EngineHost
  tray: TrayController
  window: MainWindow
}

export class AppLifecycle {
  private quitting = false
  /** The confirmation is on screen: closing again does not open another one */
  private confirming = false

  constructor(private deps: LifecycleDeps) {}

  register(): void {
    const { store, tray } = this.deps
    app.on('before-quit', event => {
      if (this.quitting) return
      if (this.busy()) {
        event.preventDefault()
        void this.confirmQuit()
        return
      }
      this.quitting = true
    })
    app.on('will-quit', () => {
      this.deps.engine.dispose()
      tray.disable()
      flushLog()
    })
    app.on('window-all-closed', () => {
      if (process.platform != 'darwin' && !(store.settings.close_to_tray && tray.enabled)) app.quit()
    })
    app.on('activate', () => this.deps.window.show())
  }

  /** The user closes the main window */
  onWindowClose(event: Electron.Event, target: BrowserWindow): void {
    if (this.quitting) return
    if (this.deps.store.settings.close_to_tray && this.deps.tray.enabled) {
      event.preventDefault()
      target.hide()
      return
    }
    /** On macOS the app stays in the Dock and the engine keeps working */
    if (process.platform == 'darwin') return
    if (this.busy()) {
      event.preventDefault()
      void this.confirmQuit()
    }
  }

  private busy(): boolean {
    return this.deps.projects.isRunning() || this.deps.projects.isDeleting()
  }

  private async confirmQuit(): Promise<void> {
    if (this.confirming) return
    this.confirming = true
    try {
      await this.askToQuit()
    } finally {
      this.confirming = false
    }
  }

  private async askToQuit(): Promise<void> {
    const { projects, store, window } = this.deps
    const t = texts(store.settings.language)
    /** Deleting files only: quitting stops the deletion, not downloads */
    const deleting = !projects.isRunning()
    const title = deleting ? t.deleting_title : t.quit_title
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: [t.quit_confirm, t.cancel],
      defaultId: 1,
      cancelId: 1,
      title,
      message: title,
      detail: deleting ? t.deleting_message : t.quit_message,
    }
    const parent = window.current
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (response != 0) return
    this.quitting = true
    await projects.stopAll()
    app.quit()
  }
}
