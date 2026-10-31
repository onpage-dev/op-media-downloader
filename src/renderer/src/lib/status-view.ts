/**
 * How the renderer draws the vocabulary of states (`@shared/status`): the icon
 * and the group of each key, the words of the progress cell, the numbers of a
 * project in the table and in the inspector.
 */
import type { DestinationKind, ProjectView } from '@shared/models'
import { projectStatus, type ProjectStatus, type StatusKey, type StatusTone } from '@shared/status'
import { i18n } from '../i18n'
import { formatNumber } from './format'
import * as icons from './icons'

const t = i18n.global.t

export type StatusGroup = 'done' | 'todo' | 'running' | 'stopping' | 'warning' | 'error' | 'never' | 'offline'

export function statusGroup(key: StatusKey): StatusGroup {
  if (key == 'done' || key == 'todo' || key == 'stopping' || key == 'never' || key == 'offline') return key
  if (key.startsWith('warning_')) return 'warning'
  if (key.startsWith('error_')) return 'error'
  return 'running'
}

const GROUP_ICONS: Record<StatusGroup, icons.IconDefinition> = {
  done: icons.faCircleCheck,
  todo: icons.faArrowDownToBracket,
  running: icons.faArrowsRotate,
  stopping: icons.faStop,
  warning: icons.faTriangleExclamation,
  error: icons.faCircleExclamation,
  never: icons.faClock,
  offline: icons.faLinkSimpleSlash,
}

export const statusIcon = (status: ProjectStatus): icons.IconDefinition => GROUP_ICONS[statusGroup(status.key)]
export const statusLabel = (status: ProjectStatus): string => t(`group.${statusGroup(status.key)}`)

/** What the progress cell says when it has no bar */
export function statusText(project: ProjectView, status = projectStatus(project)): string {
  const count = status.count ?? 0
  const listing = project.runtime.progress?.listing
  if (status.key == 'listing' && listing?.resources_total) {
    return t('status.listing_progress', { done: listing.resources_done, total: listing.resources_total })
  }
  return t(`status.${status.key}`, { count: formatNumber(count) }, count)
}

/** The kinds of destination and their icons */
export const KIND_ICONS: Record<DestinationKind, icons.IconDefinition> = {
  local: icons.faFolder,
  network: icons.faFolderWireless,
  removable: icons.faHardDrive,
  unknown: icons.faFolder,
}
export const kindOf = (project: ProjectView): DestinationKind => project.folder_info?.kind ?? 'unknown'

/**
 * Files in place and files wanted, for the table: while a job runs its
 * counters, else the last plan or result; while the list is read or compared
 * the files wanted are not known yet
 */
export function fileCounts(project: ProjectView): [number, number | undefined] | undefined {
  const { phase, progress, plan, last_result } = project.runtime
  if (progress && progress.total > 0) {
    return [progress.downloaded + progress.linked + progress.already_present, progress.total]
  }
  const counts: [number, number] | undefined = plan
    ? [plan.up_to_date, plan.remote_names]
    : last_result && [last_result.downloaded + last_result.linked + last_result.already_present, last_result.total]
  const reading = phase == 'preparing' || phase == 'listing' || phase == 'comparing'
  return counts && (reading ? [counts[0], undefined] : counts)
}

/**
 * The tone's classes, the one source for every part of the app: a mark (icon,
 * dot) or the words of a warning (`TONE_FG`), a fill (`TONE_SOFT`), a dot
 * (`TONE_DOT`), a toast's border (`TONE_LINE`); the icon of a notice
 */
export const TONE_FG = {
  success: 'text-success-fg',
  info: 'text-info-fg',
  accent: 'text-accent-fg',
  warning: 'text-warning-fg',
  danger: 'text-danger-fg',
  neutral: 'text-neutral-fg',
} as const
export const TONE_SOFT = {
  success: 'bg-success-soft',
  info: 'bg-info-soft',
  accent: 'bg-accent-soft',
  warning: 'bg-warning-soft',
  danger: 'bg-danger-soft',
  neutral: 'bg-neutral-soft',
} as const
export const TONE_DOT = {
  success: 'bg-success',
  info: 'bg-info',
  accent: 'bg-accent',
  warning: 'bg-warning',
  danger: 'bg-danger',
  neutral: 'bg-neutral',
} as const
export const TONE_LINE = {
  success: 'border-success',
  info: 'border-info',
  accent: 'border-accent',
  warning: 'border-warning',
  danger: 'border-danger',
  neutral: 'border-neutral',
} as const
export const TONE_ICON: Record<StatusTone, icons.IconDefinition> = {
  success: icons.faCircleCheck,
  info: icons.faCircleInfo,
  accent: icons.faCircleInfo,
  warning: icons.faTriangleExclamation,
  danger: icons.faCircleExclamation,
  neutral: icons.faCircleInfo,
}
/** Warnings and errors write in their tone; the others in the text's colour */
export const toneText = (tone: StatusTone): string => (tone == 'warning' || tone == 'danger' ? TONE_FG[tone] : '')
