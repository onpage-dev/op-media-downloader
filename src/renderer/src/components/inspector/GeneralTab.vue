<script setup lang="ts">
/**
 * «Generale»: where the files come from and where they go («progetto On Page
 * → cartella»), what needs the user's attention, the counts (with the speed
 * of the last seconds while it downloads) and when it ran.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Issue, IssueCode, JobPhase, ProjectView } from '@shared/models'
import { projectStatus } from '@shared/status'
import icon from '../../../assets/app-icon.png'
import { formatBytes, formatEta, formatHour, formatNumber, formatSpeed, formatWhen } from '../../lib/format'
import * as icons from '../../lib/icons'
import { KIND_ICONS, kindOf } from '../../lib/status-view'
import { app, ask, edit, retryFailed, sync } from '../../store'
import AppIcon from '../ui/AppIcon.vue'
import StatusTag from '../ui/StatusTag.vue'
import UiAlert from '../ui/UiAlert.vue'
import UiButton from '../ui/UiButton.vue'
import UiSparkline from '../ui/UiSparkline.vue'

const props = defineProps<{ project: ProjectView; width: number }>()
const { t } = useI18n()

const status = computed(() => projectStatus(props.project))
const runtime = computed(() => props.project.runtime)
const running = computed(() => runtime.value.phase != 'idle')
const info = computed(() => props.project.folder_info)

/** The alerts: while a job runs only what blocks or slows it; the double space is the tag of the folder */
const SHOWN_WHILE_RUNNING: IssueCode[] = ['rate_limited', 'offline', 'folder_unreachable', 'folder_locked', 'disk_full']
const issues = computed(() =>
  runtime.value.issues
    .filter(i => i.code != 'copies_instead_of_links' && (!running.value || SHOWN_WHILE_RUNNING.includes(i.code)))
    .slice(0, 2),
)
function toneOf(issue: Issue): 'danger' | 'warning' | 'info' | 'neutral' {
  if (issue.code == 'offline') return 'neutral'
  if (issue.code == 'rate_limited') return 'info'
  return issue.severity == 'error' ? 'danger' : 'warning'
}
interface Action {
  key: string
  primary?: boolean
  run: () => void
}
function actionsOf(issue: Issue): Action[] {
  const id = props.project.id
  const retry: Action = { key: 'retry', run: () => sync(id) }
  switch (issue.code) {
    case 'token_invalid':
    case 'project_unavailable':
      return [{ key: 'change_token', run: () => edit(id) }, retry]
    case 'folder_unreachable':
    case 'folder_not_writable':
    case 'folder_protected':
      return [{ key: 'change_folder', run: () => edit(id) }, retry]
    case 'folder_locked':
    case 'disk_full':
    case 'listing_failed':
      return [retry]
    case 'interrupted':
      return [{ key: 'sync', run: () => sync(id) }]
    case 'cleanup_needs_confirmation':
      return [{ key: 'confirm', run: () => ask('cleanup', id) }]
    case 'failed_files':
      return [{ key: 'see', run: () => (app.tab = 'failed') }, { key: 'retry_failed', run: () => retryFailed(id) }]
    case 'duplicates':
      return [{ key: 'see_duplicates', run: () => (app.tab = 'duplicates') }]
    default:
      return []
  }
}

const counts = computed(() => {
  const progress = runtime.value.progress
  const source = progress && progress.total > 0 ? progress : runtime.value.last_result
  return {
    downloaded: source?.downloaded ?? 0,
    present: source?.already_present ?? 0,
    failed: source?.failed ?? 0,
    total: source?.total ?? runtime.value.plan?.remote_names,
  }
})
const narrow = computed(() => props.width < 800)
const tiles = computed(() => {
  const c = counts.value
  const all = [
    { key: 'downloaded', icon: icons.faCircleCheck, tone: 'success', value: formatNumber(c.downloaded), lit: c.downloaded > 0 },
    { key: 'present', icon: icons.faLink, tone: 'info', value: formatNumber(c.present), lit: c.present > 0, wide: true },
    { key: 'failed', icon: icons.faCircleExclamation, tone: 'danger', value: formatNumber(c.failed), lit: c.failed > 0 },
    { key: 'total', icon: icons.faHashtag, tone: 'neutral', value: c.total != null ? formatNumber(c.total) : '—', lit: false },
    { key: 'size', icon: icons.faHardDrive, tone: 'neutral', value: formatBytes(runtime.value.plan?.remote_bytes), lit: false, wide: true },
  ] as const
  return all.filter(tile => !narrow.value || !('wide' in tile) || !running.value)
})
const SOFT = { success: 'bg-success-soft text-success-fg', info: 'bg-info-soft text-info-fg', danger: 'bg-danger-soft text-danger-fg', neutral: '' } as const

/** The four steps of a sync: read the list, compare it with the folder, download, link and clean up */
const STEPS: Partial<Record<JobPhase, number>> = { preparing: 1, listing: 1, comparing: 2, downloading: 3, finishing: 4 }
const meta = computed(() => {
  const { phase, progress } = runtime.value
  if (running.value && progress) {
    const time = formatHour(progress.started_at)
    const step = STEPS[phase]
    if (!step) return t('general.stopping', { time })
    const words = { time, step, phase: t(`general.phase.${phase}`) }
    if (phase != 'downloading') return t('general.running_short', words)
    return t('general.running', { ...words, eta: formatEta(progress.eta_seconds), concurrency: progress.concurrency })
  }
  const last = runtime.value.last_result
  if (!last) return t('general.never')
  return t('general.last', { when: formatWhen(last.ended_at), result: t(`general.outcome.${last.outcome}`) })
})
const plan = computed(() => runtime.value.plan)
</script>

<template>
  <div class="flex flex-col gap-md">
    <div class="flex items-center gap-md">
      <div class="flex min-w-0 flex-1 flex-col gap-xs rounded-md bg-box-soft p-md">
        <div class="flex items-center gap-[6px] text-xs text-secondary">
          <img :src="icon" class="h-[14px] w-[14px]" alt="" />
          {{ t('general.onpage') }}
        </div>
        <div class="truncate text-sm font-medium">{{ project.label }}</div>
        <div class="text-xs text-secondary">
          {{ plan ? t('general.remote', { files: formatNumber(plan.remote_names), size: formatBytes(plan.remote_bytes) }) : t('general.remote_unknown') }}
        </div>
      </div>
      <div class="flex shrink-0 flex-col items-center justify-center gap-2xs text-xs text-secondary">
        <AppIcon :icon="icons.faArrowRight" class="text-[17px]" />
        {{ status.progress != null && running ? `${Math.floor(status.progress * 100)}%` : t('general.to') }}
      </div>
      <div class="flex min-w-0 flex-1 flex-col gap-xs rounded-md bg-box-soft p-md">
        <div class="flex items-center gap-[6px] text-xs text-secondary">
          <AppIcon :icon="KIND_ICONS[kindOf(project)]" />
          {{ t(`kind.${kindOf(project)}`) }}
        </div>
        <div v-tooltip="project.folder" class="truncate text-sm font-medium">{{ project.folder }}</div>
        <div class="text-xs text-secondary">
          <template v-if="info?.free_bytes != null">{{ t('general.free', { free: formatBytes(info.free_bytes) }) }} · </template>
          {{ info?.hardlinks === true ? t('general.hardlinks_yes') : info?.hardlinks === false ? t('general.hardlinks_no') : t('general.hardlinks_unknown') }}
        </div>
        <StatusTag
          v-if="info?.hardlinks === false"
          class="self-start"
          tone="warning"
          :icon="icons.faTriangleExclamation"
          :label="t('general.double_space')"
        />
      </div>
    </div>

    <UiAlert v-for="issue in issues" :key="issue.code" :tone="toneOf(issue)" :title="t(`issue.${issue.code}.title`, { count: formatNumber(issue.count ?? 0) }, issue.count ?? 0)">
      {{ t(`issue.${issue.code}.text`, { folder: project.folder, detail: issue.detail ?? '' }) }}
      <template v-if="actionsOf(issue).length" #actions>
        <UiButton v-for="action in actionsOf(issue)" :key="action.key" @click="action.run">{{ t(`issue.action.${action.key}`) }}</UiButton>
      </template>
    </UiAlert>

    <div class="flex gap-sm">
      <div
        v-for="tile in tiles"
        :key="tile.key"
        class="flex min-w-0 flex-1 flex-col gap-xs rounded-md border border-line bg-box p-md"
      >
        <div class="flex items-center gap-[6px]">
          <span class="truncate text-xs text-secondary">{{ t(`general.${tile.key}`) }}</span>
          <span class="flex-1" />
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px]"
            :class="tile.lit ? SOFT[tile.tone] : 'bg-box-soft text-secondary'"
          >
            <AppIcon :icon="tile.icon" />
          </span>
        </div>
        <div class="tabular font-title text-xl font-bold">{{ tile.value }}</div>
      </div>
      <div
        v-if="runtime.phase == 'downloading' && runtime.progress"
        class="flex min-w-0 flex-1 flex-col gap-xs rounded-md border border-line bg-box p-md"
      >
        <div class="flex items-center gap-[6px]">
          <span class="truncate text-xs text-secondary">{{ t('general.speed') }}</span>
          <span class="flex-1" />
          <UiSparkline :values="app.speeds[project.id] ?? []" />
        </div>
        <div class="tabular whitespace-nowrap font-title text-xl font-bold">{{ formatSpeed(runtime.progress.speed_bps) }}</div>
      </div>
    </div>

    <p class="text-xs text-secondary">{{ meta }}</p>
  </div>
</template>
