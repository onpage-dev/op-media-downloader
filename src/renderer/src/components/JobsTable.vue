<script setup lang="ts">
/**
 * The projects as a table of jobs: the state as a compact OpStatusTag, the
 * project, where it downloads, the progress (OpProgressBar s with the time
 * left, the spinner while it reads or compares, else what the state says),
 * the files in place and wanted, the speed and the last sync. Headers sort,
 * the arrows move the selection, the right button opens the menu.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ProjectView } from '@shared/models'
import { projectStatus } from '@shared/status'
import { formatEtaShort, formatNumber, formatSpeed, formatWhen } from '../lib/format'
import { faChevronDown, faChevronUp } from '../lib/icons'
import { fileCounts, KIND_ICONS, kindOf, statusIcon, statusLabel, statusText } from '../lib/status-view'
import { app, ask, moveSelection, select, visible, type SortKey } from '../store'
import AppIcon from './ui/AppIcon.vue'
import ProgressBar from './ui/ProgressBar.vue'
import StatusTag from './ui/StatusTag.vue'
import UiButton from './ui/UiButton.vue'
import UiSpinner from './ui/UiSpinner.vue'

const { t } = useI18n()
/** The columns as wide as at 1100px; under 820px of table (900px of window) «Velocità» goes and the others narrow */
const COLUMNS: { key: SortKey; label: string; wide: string; narrow?: string }[] = [
  { key: 'status', label: 'table.status', wide: '36px' },
  { key: 'label', label: 'table.project', wide: 'minmax(120px, 176fr)', narrow: 'minmax(100px, 150fr)' },
  { key: 'folder', label: 'table.destination', wide: 'minmax(120px, 196fr)', narrow: 'minmax(100px, 150fr)' },
  { key: 'progress', label: 'table.progress', wide: '170px', narrow: '150px' },
  { key: 'files', label: 'table.files', wide: '112px', narrow: '100px' },
  { key: 'speed', label: 'table.speed', wide: '76px' },
  { key: 'last', label: 'table.last', wide: '133px', narrow: '113px' },
]
const root = ref<HTMLElement>()
const width = ref(900)
const observer = new ResizeObserver(([entry]) => (width.value = entry.contentRect.width))
onMounted(() => root.value && observer.observe(root.value))
onBeforeUnmount(() => observer.disconnect())
const narrow = computed(() => width.value < 820)
const columns = computed(() => COLUMNS.filter(c => !narrow.value || c.key != 'speed'))
const template = computed(() => columns.value.map(c => (narrow.value && c.narrow) || c.wide).join(' '))
const shows = (key: SortKey): boolean => columns.value.some(c => c.key == key)

const rows = computed(() =>
  visible.value.map(project => ({ project, status: projectStatus(project), files: fileCounts(project) })),
)

function sortBy(key: SortKey): void {
  if (app.sort.key == key) app.sort.dir = app.sort.dir > 0 ? -1 : 1
  else app.sort = { key, dir: 1 }
}
function onKey(event: KeyboardEvent): void {
  if (event.key == 'ArrowDown' || event.key == 'ArrowUp') {
    event.preventDefault()
    moveSelection(event.key == 'ArrowDown' ? 1 : -1)
  }
}
function openMenu(event: MouseEvent, project: ProjectView): void {
  select(project.id)
  app.menu = { id: project.id, x: event.clientX, y: event.clientY }
}
function showAll(): void {
  app.filter = 'all'
  app.kind = undefined
  app.query = ''
}
const muted = (key: string): boolean => key == 'done' || key == 'never' || key == 'offline'
</script>

<template>
  <div ref="root" class="flex min-h-0 flex-col outline-none" tabindex="0" role="grid" @keydown="onKey">
    <div role="row" class="grid h-[33px] shrink-0 border-b border-line" :style="{ gridTemplateColumns: template }">
      <button
        v-for="column in columns"
        :key="column.key"
        v-tooltip="column.key == 'status' ? t(column.label) : undefined"
        type="button"
        role="columnheader"
        :aria-sort="app.sort.key == column.key ? (app.sort.dir > 0 ? 'ascending' : 'descending') : 'none'"
        class="flex min-w-0 items-center gap-xs px-sm text-left text-xs font-medium hover:bg-text/[.04]"
        :class="app.sort.key == column.key ? 'text-text' : 'text-secondary'"
        @click="sortBy(column.key)"
      >
        <span v-if="column.key != 'status'" class="truncate">{{ t(column.label) }}</span>
        <AppIcon v-if="app.sort.key == column.key" :icon="app.sort.dir > 0 ? faChevronUp : faChevronDown" class="text-[10px]" />
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-auto">
      <div
        v-for="{ project, status, files } in rows"
        :key="project.id"
        role="row"
        :aria-selected="project.id == app.selectedId"
        class="grid h-[37px] items-center border-b border-box-soft"
        :class="project.id == app.selectedId ? 'bg-accent-soft' : 'hover:bg-text/[.03]'"
        :style="{ gridTemplateColumns: template }"
        @mousedown="select(project.id)"
        @contextmenu.prevent="openMenu($event, project)"
        @keydown.delete="ask('delete', project.id)"
      >
        <div class="flex pl-sm">
          <StatusTag compact :tone="status.tone" :icon="statusIcon(status)" :label="statusLabel(status)" />
        </div>
        <div class="truncate px-sm text-sm" :class="project.id == app.selectedId ? 'font-medium' : ''">{{ project.label }}</div>
        <div class="flex min-w-0 items-center gap-[6px] px-sm text-secondary">
          <AppIcon :icon="KIND_ICONS[kindOf(project)]" />
          <span v-tooltip="project.folder" class="truncate text-xs">{{ project.folder }}</span>
        </div>
        <div class="flex min-w-0 items-center gap-[6px] px-sm text-xs">
          <template v-if="status.key == 'downloading' || status.key == 'finishing' || status.key == 'stopping'">
            <ProgressBar
              class="min-w-0 flex-1"
              :value="status.progress ?? 0"
              :tone="status.key == 'stopping' ? 'warning' : 'accent'"
              :lined="project.id == app.selectedId"
            />
            <span v-if="status.key != 'stopping'" class="min-w-[46px] shrink-0 text-secondary">{{ formatEtaShort(project.runtime.progress?.eta_seconds) }}</span>
          </template>
          <template v-else-if="status.key == 'listing' || status.key == 'comparing'">
            <UiSpinner class="text-accent-fg" />
            <span class="truncate">{{ statusText(project, status) }}</span>
          </template>
          <span v-else class="truncate" :class="muted(status.key) ? 'text-secondary' : ''">{{ statusText(project, status) }}</span>
        </div>
        <div class="tabular truncate px-sm text-xs">
          {{ files ? (files[1] != null ? `${formatNumber(files[0])} / ${formatNumber(files[1])}` : formatNumber(files[0])) : '—' }}
        </div>
        <div v-if="shows('speed')" class="tabular truncate px-sm text-xs" :class="project.runtime.phase == 'downloading' ? '' : 'text-secondary'">
          {{ project.runtime.phase == 'downloading' && project.runtime.progress ? formatSpeed(project.runtime.progress.speed_bps) : '—' }}
        </div>
        <div class="truncate px-sm text-xs text-secondary">{{ formatWhen(project.runtime.last_result?.ended_at) || t('table.never') }}</div>
      </div>
      <div v-if="!rows.length && app.projects.length" class="flex flex-col items-center gap-lg px-lg py-3xl text-center">
        <p class="text-xl text-secondary">{{ t('table.no_results') }}</p>
        <UiButton size="sm" @click="showAll">{{ t('table.show_all') }}</UiButton>
      </div>
    </div>
  </div>
</template>
