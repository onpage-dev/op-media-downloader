<script setup lang="ts">
/**
 * The panel the icon in the notification area opens (main shows `#/tray` in a
 * frameless window): what runs and how fast, each project with its state,
 * «Sincronizza tutto», «Apri» and «Esci». A row opens the main window on it.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ProjectView } from '@shared/models'
import { projectStatus, type ProjectStatus } from '@shared/status'
import icon from '../../assets/app-icon.png'
import { formatEtaShort, formatPercent, formatSpeed, formatWhen } from '../lib/format'
import * as icons from '../lib/icons'
import { statusIcon, statusLabel, statusText } from '../lib/status-view'
import { app, quit, showMainWindow as show, syncAll } from '../store'
import IconButton from './ui/IconButton.vue'
import ProgressBar from './ui/ProgressBar.vue'
import StatusTag from './ui/StatusTag.vue'
import UiButton from './ui/UiButton.vue'

const { t } = useI18n()
const rows = computed(() =>
  [...app.projects]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map(project => ({ project, status: projectStatus(project) })),
)
const summary = computed(() => {
  const status = app.status
  if (!app.projects.length) return t('tray.empty')
  if (status?.running_jobs)
    return t('tray.running', { count: status.running_jobs, speed: formatSpeed(status.speed_bps) })
  return t('tray.idle')
})
/** What a row says under its name: the state's words, with when for a project up to date */
function words(project: ProjectView, status: ProjectStatus): string {
  if (status.key == 'comparing') return t('tray.comparing')
  const text = statusText(project, status)
  return status.key == 'done' ? `${text} · ${formatWhen(project.runtime.last_result?.ended_at)}` : text
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-box">
    <header class="flex shrink-0 items-center gap-sm py-md pl-lg pr-md">
      <img :src="icon" class="h-5 w-5" alt="" />
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium leading-[19px]">{{ t('app.short') }}</div>
        <div class="truncate text-xs text-secondary">{{ summary }}</div>
      </div>
      <IconButton :icon="icons.faGear" :label="t('toolbar.settings')" @click="show({ type: 'open_settings' })" />
    </header>
    <ul class="min-h-0 flex-1 overflow-auto border-y border-line p-xs">
      <li v-for="{ project, status } in rows" :key="project.id">
        <button
          type="button"
          class="flex w-full items-center gap-sm-md rounded-md px-md py-sm text-left hover:bg-tint"
          @click="show({ type: 'select_project', project_id: project.id })"
        >
          <StatusTag compact :tone="status.tone" :icon="statusIcon(status)" :label="statusLabel(status)" />
          <span class="flex min-w-0 flex-1 flex-col gap-2xs">
            <span class="truncate text-sm">{{ project.label }}</span>
            <ProgressBar
              v-if="status.key == 'downloading' || status.key == 'finishing'"
              class="w-[260px] max-w-full"
              size="xs"
              :value="status.progress ?? 0"
              :name="project.label"
              :label="`${formatPercent(status.progress ?? 0)} · ${formatEtaShort(project.runtime.progress?.eta_seconds)}`"
            />
            <span v-else class="truncate text-xs text-secondary">{{ words(project, status) }}</span>
          </span>
        </button>
      </li>
    </ul>
    <footer class="flex shrink-0 items-center gap-sm p-md">
      <UiButton variant="primary" :icon="icons.faLayerGroup" @click="syncAll">{{ t('toolbar.sync_all') }}</UiButton>
      <UiButton :icon="icons.faWindowRestore" @click="show()">{{ t('tray.open') }}</UiButton>
      <span class="flex-1" />
      <!-- An icon: the two buttons keep their room in every language -->
      <IconButton :icon="icons.faPowerOff" :label="t('tray.quit')" :size="36" @click="quit" />
    </footer>
  </div>
</template>
