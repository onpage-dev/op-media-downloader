/**
 * What the app shows of its projects besides the page: the projects and the
 * status pushed to the windows (the status throttled), the taskbar progress,
 * the tray icon and tooltip, and the power save blocker while jobs run or
 * the files of a removed project are being deleted.
 */
import { BrowserWindow, net, powerSaveBlocker } from 'electron'
import { EVENTS } from '../shared/ipc-channels'
import { AppStatus, ProjectView, SyncResult } from '../shared/models'
import { aggregateTone, projectStatus } from '../shared/status'
import { texts } from './i18n'
import { ProjectService } from './projects'
import { AppStore } from './store'
import { updateTaskbar } from './taskbar'
import { TrayController } from './tray'

const STATUS_THROTTLE_MS = 250
const ONLINE_CHECK_MS = 10_000

export interface StatusDeps {
  store: AppStore
  projects: ProjectService
  tray: TrayController
  /** The main window, when there is one */
  window: () => BrowserWindow | undefined
  /** To every window of the app */
  broadcast: (channel: string, ...args: unknown[]) => void
}

export class StatusController {
  private online = net.isOnline()
  private blocker?: number
  /** Red taskbar after an error, until the user looks at the window */
  private show_errors = false
  private status_timer?: NodeJS.Timeout

  constructor(private deps: StatusDeps) {}

  start(): void {
    this.deps.projects.onChanged(views => this.onProjects(views))
    setInterval(() => {
      const now = net.isOnline()
      if (now == this.online) return
      this.online = now
      this.broadcastStatus()
    }, ONLINE_CHECK_MS)
  }

  status(): AppStatus {
    return this.deps.projects.status(this.online)
  }

  /** The window got the focus: the errors have been seen */
  windowFocused(window: BrowserWindow): void {
    this.show_errors = false
    updateTaskbar(window, this.deps.projects.views(), false)
  }

  /** A failure turns the taskbar red until the window gets the focus */
  jobEnded(result: SyncResult, window_focused: boolean): void {
    if (result.outcome == 'failed' && !window_focused) this.show_errors = true
  }

  updateTray(views: ProjectView[] = this.deps.projects.views()): void {
    const t = texts(this.deps.store.settings.language)
    const running = views.filter(view => view.runtime.phase != 'idle').length
    const attention = views.filter(view => ['danger', 'warning'].includes(projectStatus(view).tone)).length
    const tooltip = [
      t.app_name,
      running ? t.tray_running(running) : attention ? t.tray_attention(attention) : t.tray_idle,
    ].join('\n')
    const tone = aggregateTone(views)
    this.deps.tray.update(tone == 'success' ? undefined : tone, tooltip)
  }

  private onProjects(views: ProjectView[]): void {
    this.deps.broadcast(EVENTS.projectsChanged, views)
    updateTaskbar(this.deps.window(), views, this.show_errors)
    this.updateTray(views)
    this.updatePowerBlocker()
    this.broadcastStatus()
  }

  private broadcastStatus(): void {
    if (this.status_timer) return
    this.status_timer = setTimeout(() => {
      this.status_timer = undefined
      this.deps.broadcast(EVENTS.appStatus, this.status())
    }, STATUS_THROTTLE_MS)
  }

  private updatePowerBlocker(): void {
    const busy = this.deps.projects.isRunning() || this.deps.projects.isDeleting()
    if (busy && this.blocker === undefined) this.blocker = powerSaveBlocker.start('prevent-app-suspension')
    if (!busy && this.blocker !== undefined) {
      powerSaveBlocker.stop(this.blocker)
      this.blocker = undefined
    }
  }
}
