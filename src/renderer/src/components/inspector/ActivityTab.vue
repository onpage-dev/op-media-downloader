<script setup lang="ts">
/**
 * «Attività»: the live log of the project, as a download manager's: the time,
 * the file, its size and what happened; the files on their way with a bar.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ActivityEntry, ActivityOutcome, ProjectView } from '@shared/models'
import type { StatusTone } from '@shared/status'
import { formatBytes, formatClock } from '../../lib/format'
import * as icons from '../../lib/icons'
import { app } from '../../store'
import AppIcon from '../ui/AppIcon.vue'
import ProgressBar from '../ui/ProgressBar.vue'
import StatusTag from '../ui/StatusTag.vue'

const props = defineProps<{ project: ProjectView }>()
const { t } = useI18n()
const entries = computed(() => app.activity[props.project.id] ?? [])

const OUTCOMES: Record<Exclude<ActivityOutcome, 'downloading'>, [StatusTone, icons.IconDefinition]> = {
  downloaded: ['success', icons.faCircleCheck],
  linked: ['info', icons.faLink],
  removed: ['neutral', icons.faTrashCan],
  failed: ['danger', icons.faCircleExclamation],
  conflict: ['warning', icons.faTriangleExclamation],
}
function fileIcon(name: string): icons.IconDefinition {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'tif', 'tiff', 'svg', 'bmp', 'heic', 'avif'].includes(ext)) return icons.faFileImage
  if (ext == 'pdf') return icons.faFilePdf
  if (['mp4', 'mov', 'webm', 'avi', 'mkv'].includes(ext)) return icons.faFileVideo
  return icons.faFileLines
}
/** Why, after the outcome's tag: the reasons are written to follow it (the failed tab capitalizes them) */
function note(entry: ActivityEntry): string {
  if (entry.reason) return t(`reason.${entry.reason}`)
  if (entry.same_as) return t('activity.same_as', { name: entry.same_as })
  if (entry.outcome == 'removed') return t('activity.removed_why')
  return ''
}
</script>

<template>
  <div class="flex flex-col">
    <div class="grid h-7 grid-cols-[72px_minmax(0,1fr)_96px_minmax(0,330px)] border-b border-line text-xs font-medium text-secondary">
      <span class="self-center px-sm">{{ t('activity.time') }}</span>
      <span class="self-center px-sm">{{ t('activity.file') }}</span>
      <span class="self-center px-sm">{{ t('activity.size') }}</span>
      <span class="self-center px-sm">{{ t('activity.outcome') }}</span>
    </div>
    <div
      v-for="entry in entries"
      :key="entry.id"
      class="grid h-8 grid-cols-[72px_minmax(0,1fr)_96px_minmax(0,330px)] items-center text-xs"
    >
      <span class="tabular px-sm text-secondary">{{ formatClock(entry.at) }}</span>
      <span class="flex min-w-0 items-center gap-sm px-sm">
        <span class="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm bg-box-soft text-secondary">
          <AppIcon :icon="fileIcon(entry.name)" />
        </span>
        <span class="truncate">{{ entry.name }}</span>
      </span>
      <span class="tabular px-sm text-secondary">{{ entry.size != null ? formatBytes(entry.size) : '—' }}</span>
      <span class="flex min-w-0 items-center gap-sm px-sm">
        <ProgressBar v-if="entry.outcome == 'downloading'" class="w-[140px]" size="xs" :value="entry.progress ?? 0" />
        <template v-else>
          <StatusTag :tone="OUTCOMES[entry.outcome][0]" :icon="OUTCOMES[entry.outcome][1]" :label="t(`activity.result.${entry.outcome}`)" />
          <span class="truncate text-secondary">{{ note(entry) }}</span>
        </template>
      </span>
    </div>
    <p v-if="!entries.length" class="py-xl text-center text-secondary">{{ t('activity.empty') }}</p>
  </div>
</template>
