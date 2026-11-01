/**
 * One vocabulary of states for every place that shows a project: the table,
 * the inspector, the tray panel, the taskbar and the notifications.
 * Texts live in the renderer (i18n) and in main (tray, notifications): here
 * only keys, tones and numbers.
 */
import { IssueCode, ProjectView } from './models'

export type StatusTone = 'success' | 'info' | 'accent' | 'warning' | 'danger' | 'neutral'

export type StatusKey =
  /** Aggiornato */
  | 'done'
  /** N file da scaricare */
  | 'todo'
  /** In corso: lettura da On Page */
  | 'listing'
  /** In corso: confronto con la cartella */
  | 'comparing'
  /** In corso: scaricamento */
  | 'downloading'
  /** In corso: collegamenti e pulizia */
  | 'finishing'
  /** Interruzione in corso */
  | 'stopping'
  /** Attenzione: file non scaricati */
  | 'warning_failed'
  /** Attenzione: nomi con file diversi */
  | 'warning_duplicates'
  /** Attenzione: nomi già usati da file non dell'app */
  | 'warning_conflicts'
  /** Attenzione: la cartella copia invece di collegare */
  | 'warning_copies'
  /** Attenzione: file da togliere, serve una conferma */
  | 'warning_cleanup'
  /** Attenzione: l'ultima sincronizzazione si è interrotta, va rifatta */
  | 'warning_interrupted'
  /** Attenzione: alcune raccolte non sono state lette */
  | 'warning_incomplete'
  /** Errore: token non valido o progetto non disponibile */
  | 'error_token'
  /** Errore: cartella non raggiungibile, non scrivibile o protetta */
  | 'error_folder'
  /** Errore: cartella in uso da un altro computer */
  | 'error_locked'
  /** Errore: cartella sincronizzata con un altro progetto On Page */
  | 'error_other_project'
  /** Errore: disco pieno */
  | 'error_disk'
  /** Errore: elenco dei file non letto */
  | 'error_listing'
  /** Errore imprevisto */
  | 'error_unexpected'
  /** In attesa della rete */
  | 'offline'
  /** Mai sincronizzato */
  | 'never'

export interface ProjectStatus {
  key: StatusKey
  tone: StatusTone
  /** 0..1 while downloading with a known total */
  progress?: number
  /** Files to download, failed, duplicated… depending on the key */
  count?: number
}

const ERROR_KEYS: [IssueCode[], StatusKey][] = [
  [['token_invalid', 'project_unavailable'], 'error_token'],
  [['folder_locked'], 'error_locked'],
  [['folder_other_project'], 'error_other_project'],
  [['folder_unreachable', 'folder_not_writable', 'folder_protected'], 'error_folder'],
  [['disk_full'], 'error_disk'],
  [['listing_failed'], 'error_listing'],
  [['unexpected'], 'error_unexpected'],
]

const WARNING_KEYS: [IssueCode, StatusKey][] = [
  ['interrupted', 'warning_interrupted'],
  ['listing_incomplete', 'warning_incomplete'],
  ['failed_files', 'warning_failed'],
  ['duplicates', 'warning_duplicates'],
  ['name_conflicts', 'warning_conflicts'],
  ['copies_instead_of_links', 'warning_copies'],
]

export function projectStatus(project: ProjectView): ProjectStatus {
  const { phase, progress, plan, issues, last_result } = project.runtime
  const issue = (code: IssueCode): { count?: number } | undefined => issues.find(i => i.code == code)

  if (phase == 'stopping') return { key: 'stopping', tone: 'warning', progress: ratio() }
  if (phase == 'preparing' || phase == 'listing') return { key: 'listing', tone: 'accent' }
  if (phase == 'comparing') return { key: 'comparing', tone: 'accent' }
  if (phase == 'downloading') return { key: 'downloading', tone: 'accent', progress: ratio() }
  if (phase == 'finishing') return { key: 'finishing', tone: 'accent', progress: ratio() }

  for (const [codes, key] of ERROR_KEYS) {
    const found = codes.map(issue).find(Boolean)
    if (found) return { key, tone: 'danger', count: found.count }
  }
  if (issue('offline')) return { key: 'offline', tone: 'neutral' }

  const cleanup = issue('cleanup_needs_confirmation')
  if (cleanup) return { key: 'warning_cleanup', tone: 'warning', count: cleanup.count }

  if (plan && plan.to_download_names > 0) {
    return { key: 'todo', tone: 'info', count: plan.to_download_names }
  }

  for (const [code, key] of WARNING_KEYS) {
    const found = issue(code)
    if (found) return { key, tone: 'warning', count: found.count }
  }

  if (last_result) return { key: 'done', tone: 'success' }
  return { key: 'never', tone: 'neutral' }

  function ratio(): number | undefined {
    if (!progress) return undefined
    if (progress.bytes_total > 0) return Math.min(1, progress.bytes_done / progress.bytes_total)
    if (progress.total > 0) {
      const done = progress.downloaded + progress.linked + progress.removed + progress.failed
      return Math.min(1, done / progress.total)
    }
    return undefined
  }
}

/** The filters on the left of the window; they overlap (a first download is both running and never synced) */
export const PROJECT_FILTERS = ['all', 'running', 'todo', 'errors', 'done', 'never'] as const
export type ProjectFilter = (typeof PROJECT_FILTERS)[number]

export function matchesFilter(project: ProjectView, filter: ProjectFilter): boolean {
  const status = projectStatus(project)
  switch (filter) {
    case 'all':
      return true
    case 'running':
      return project.runtime.phase != 'idle'
    case 'todo':
      /** A project already downloading is «In corso», not waiting for «Scarica» */
      return project.runtime.phase == 'idle' && (project.runtime.plan?.to_download_names ?? 0) > 0
    case 'errors':
      return status.tone == 'danger'
    case 'done':
      return status.key == 'done' || status.key.startsWith('warning_')
    case 'never':
      return !project.runtime.last_result
  }
}

/** Taskbar / dock: the worst state across projects wins */
export function aggregateTone(projects: ProjectView[]): StatusTone | undefined {
  const tones = projects.map(p => projectStatus(p).tone)
  for (const tone of ['danger', 'warning', 'accent', 'info'] as StatusTone[]) {
    if (tones.includes(tone)) return tone
  }
  return tones.length ? 'success' : undefined
}
