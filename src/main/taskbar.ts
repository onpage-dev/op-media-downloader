/**
 * Progress on the taskbar button (Windows, Linux) and on the Dock (macOS):
 * green while downloading, paused while stopping, red after an error until
 * the window gets the focus again; the Dock badge counts projects to look at.
 */
import { app, BrowserWindow } from 'electron'
import { ProjectView } from '../shared/models'
import { projectStatus } from '../shared/status'

export function updateTaskbar(window: BrowserWindow | undefined, views: ProjectView[], show_errors: boolean): void {
  if (!window || window.isDestroyed()) return

  const running = views.filter(view => view.runtime.phase != 'idle')
  const statuses = views.map(projectStatus)

  if (running.length) {
    const stopping = running.every(view => view.runtime.phase == 'stopping')
    let done = 0
    let total = 0
    for (const view of running) {
      const progress = view.runtime.progress
      if (!progress) continue
      done += progress.bytes_total
        ? progress.bytes_done
        : progress.downloaded + progress.linked + progress.removed + progress.failed
      total += progress.bytes_total || progress.total
    }
    if (total > 0) window.setProgressBar(Math.min(1, done / total), { mode: stopping ? 'paused' : 'normal' })
    else window.setProgressBar(2, { mode: 'indeterminate' })
  } else if (show_errors && statuses.some(status => status.tone == 'danger')) {
    window.setProgressBar(1, { mode: 'error' })
  } else {
    window.setProgressBar(-1)
  }

  if (process.platform == 'darwin') {
    const attention = statuses.filter(status => status.tone == 'danger' || status.key == 'todo').length
    app.dock?.setBadge(attention ? String(attention) : '')
  }
}
