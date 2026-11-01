/**
 * The main window as the rest of main uses it: created when needed (closing
 * it destroys it), shown with the command that asked for it (menus, tray,
 * jump list, notifications). A command sent while the page loads waits for it.
 */
import { BrowserWindow } from 'electron'
import { AppCommand, InspectorTab } from '../shared/desktop-api'
import { EVENTS } from '../shared/ipc-channels'
import { ProjectId } from '../shared/models'
import { AppStore } from './store'
import { createMainWindow } from './window'

export interface MainWindowDeps {
  store: AppStore
  /** A command from the tray panel: the panel gets out of the way */
  hidePanel: () => void
  onFocus: (window: BrowserWindow) => void
  /** The user closes the window: to the tray, or a confirmation while work runs */
  onClose: (event: Electron.Event, window: BrowserWindow) => void
}

export class MainWindow {
  private window?: BrowserWindow
  private pending: AppCommand[] = []

  constructor(private deps: MainWindowDeps) {}

  get current(): BrowserWindow | undefined {
    return this.window && !this.window.isDestroyed() ? this.window : undefined
  }

  get focused(): boolean {
    return this.current?.isFocused() ?? false
  }

  show(): BrowserWindow {
    const target = this.ensure()
    if (target.isMinimized()) target.restore()
    if (target.webContents.isLoading()) return target
    target.show()
    target.focus()
    return target
  }

  sendCommand(command: AppCommand): void {
    this.deps.hidePanel()
    const target = this.show()
    if (target.webContents.isLoading()) this.pending.push(command)
    else target.webContents.send(EVENTS.appCommand, command)
  }

  focusProject(id: ProjectId, tab?: InspectorTab): void {
    this.sendCommand({ type: 'select_project', project_id: id, tab })
  }

  private ensure(): BrowserWindow {
    const existing = this.current
    if (existing) return existing
    const created = createMainWindow(this.deps.store)
    let shown = false
    const flush = (): void => {
      for (const command of this.pending.splice(0)) created.webContents.send(EVENTS.appCommand, command)
    }
    created.once('ready-to-show', () => {
      shown = true
      created.show()
      flush()
    })
    /** A page that crashed was loaded again (ready-to-show comes only once) */
    created.webContents.on('did-finish-load', () => {
      if (shown) flush()
    })
    created.on('focus', () => {
      this.deps.onFocus(created)
      created.webContents.send(EVENTS.windowFocus, true)
    })
    created.on('blur', () => created.webContents.send(EVENTS.windowFocus, false))
    created.on('close', event => this.deps.onClose(event, created))
    created.on('closed', () => {
      if (this.window == created) this.window = undefined
    })
    this.window = created
    return created
  }
}
