/**
 * System notifications at the end of a job: done (with new files), failed
 * files, or an error. A click opens the window on the project.
 */
import { Notification } from 'electron'
import { InspectorTab } from '../shared/desktop-api'
import { ProjectId, ProjectView, SyncResult } from '../shared/models'
import { AppStore } from './store'
import { duration, texts } from './i18n'

type ErrorKey = keyof ReturnType<typeof texts>['error_body']

export function notifyResult(
  store: AppStore,
  view: ProjectView,
  result: SyncResult,
  focusProject: (id: ProjectId, tab?: InspectorTab) => void,
): void {
  const settings = store.settings
  if (!settings.notifications || !Notification.isSupported()) return
  if (result.outcome == 'stopped') return
  const t = texts(settings.language)

  let title: string
  let body: string
  let tab: InspectorTab | undefined

  if (result.outcome == 'failed') {
    title = t.error_title(view.label)
    const code = result.error?.code as ErrorKey | undefined
    body = code && code in t.error_body ? t.error_body[code] : t.error_body.other
  } else if (result.failed > 0) {
    title = t.failed_title(view.label)
    body = t.failed_body(result.failed)
    tab = 'failed'
  } else if (result.downloaded > 0) {
    title = t.done_title(view.label)
    body = t.done_body(result.downloaded, duration(settings.language, Date.parse(result.ended_at) - Date.parse(result.started_at)))
  } else {
    /** A sync that found nothing new is not worth an interruption */
    return
  }

  const notification = new Notification({ title, body, silent: result.failed == 0 && result.outcome != 'failed' })
  notification.on('click', () => focusProject(view.id, tab))
  notification.show()
}
