<script setup lang="ts">
/**
 * The projects as a table of jobs: the state as a compact OpStatusTag, the
 * project, where it downloads, the progress (OpProgressBar s with the time
 * left, the spinner while it reads or compares, else what the state says),
 * the files in place and wanted, the speed and the last sync. Headers sort,
 * the arrows (Home, End, the pages) move the selection while the table has the
 * focus, the right button or the menu key opens the menu. The right edge of a
 * header resizes its column alone; «Sincronizzato» takes the width left, and
 * when the columns do not fit the table scrolls sideways, header included. The
 * widths are remembered; a double click on an edge goes back to the default ones.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ProjectId } from '@shared/models'
import { projectStatus } from '@shared/status'
import { formatEtaShort, formatNumber, formatSpeed, formatWhen } from '../lib/format'
import { faChevronDown, faChevronUp } from '../lib/icons'
import { fileCounts, KIND_ICONS, kindOf, statusIcon, statusLabel, statusText } from '../lib/status-view'
import { app, moveSelection, select, showAll, visible, type SortKey } from '../store'
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
const ROW_HEIGHT = 37
const root = ref<HTMLElement>()
const body = ref<HTMLElement>()
const width = ref(900)
const observer = new ResizeObserver(([entry]) => (width.value = entry.contentRect.width))
onMounted(() => root.value && observer.observe(root.value))
onBeforeUnmount(() => observer.disconnect())
const narrow = computed(() => width.value < 820)

/** How narrow each column can get; «Stato» keeps its 36px */
const MIN_WIDTH: Partial<Record<SortKey, number>> = {
  label: 80,
  folder: 80,
  progress: 90,
  files: 60,
  speed: 50,
  last: 70,
}
const resizable = (key: SortKey): boolean => MIN_WIDTH[key] !== undefined
/** «Sincronizzato» fills the width the others leave: its stored width is only its minimum */
const FILLER: SortKey = 'last'
/** The widths the user gave the columns, in px */
type Widths = Partial<Record<SortKey, number>>

const WIDTHS_KEY = 'jobs-table-columns'
function storedWidths(): Widths | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? 'null')
    if (!value || typeof value != 'object') return undefined
    const widths: Widths = {}
    for (const column of COLUMNS) {
      const size = (value as Record<string, unknown>)[column.key]
      const min = MIN_WIDTH[column.key]
      if (min !== undefined && typeof size == 'number' && Number.isFinite(size)) {
        widths[column.key] = Math.max(min, Math.round(size))
      }
    }
    return widths
  } catch {
    return undefined
  }
}
const widths = ref(storedWidths())
function rememberWidths(): void {
  try {
    if (widths.value) localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths.value))
    else localStorage.removeItem(WIDTHS_KEY)
  } catch {
    // the widths simply are not remembered
  }
}
/** The user's widths, when they name every column (a stored set from an older version may not) */
const custom = computed(() => {
  const chosen = widths.value
  return chosen && COLUMNS.every(c => !resizable(c.key) || chosen[c.key]) ? chosen : undefined
})

/** With the user's widths every column stays, the table scrolls when they do not fit */
const columns = computed(() => COLUMNS.filter(c => custom.value || !narrow.value || c.key != 'speed'))
const shows = (key: SortKey): boolean => columns.value.some(c => c.key == key)
const defaultTrack = (column: (typeof COLUMNS)[number]): string => (narrow.value && column.narrow) || column.wide
const template = computed(() =>
  columns.value
    .map(c => {
      const size = custom.value?.[c.key]
      if (!size) return defaultTrack(c)
      return c.key == FILLER ? `minmax(${size}px, 1fr)` : `${size}px`
    })
    .join(' '),
)
/** Below this width the table scrolls sideways */
const minWidth = computed(() =>
  columns.value.reduce(
    (sum, c) => sum + (custom.value?.[c.key] ?? Number(/(\d+)px/.exec(defaultTrack(c))?.[1] ?? 0)),
    0,
  ),
)

/** The widths of the columns shown, as the header lays them out now */
function measure(): Widths {
  const out: Widths = {}
  const cells = root.value?.querySelectorAll<HTMLElement>('[role=columnheader][data-key]') ?? []
  for (const cell of cells) {
    const key = cell.dataset.key as SortKey
    if (resizable(key)) out[key] = Math.round(cell.getBoundingClientRect().width)
  }
  return out
}
/** For the separators: the width of each column, in px */
const sizes = ref<Widths>({})
const measureSoon = (): void => void nextTick(() => (sizes.value = measure()))
watch([width, template], measureSoon)
onMounted(measureSoon)

/**
 * The column takes its new width, the others keep theirs. The first resize
 * fixes every column at the width it has now; a column hidden now
 * («Velocità» on a narrow window) gets its default width, and the filler
 * keeps at most its default width as its minimum, whatever it took to fill.
 */
function resize(start: Widths, key: SortKey, delta: number): void {
  const from = start[key] ?? sizes.value[key] ?? 0
  const filler = Math.min(start[FILLER] ?? 133, 133)
  widths.value = {
    speed: 76,
    ...widths.value,
    ...start,
    [FILLER]: widths.value?.[FILLER] ?? filler,
    [key]: Math.max(MIN_WIDTH[key] ?? 0, Math.round(from + delta)),
  }
}

let drag: { key: SortKey; x: number; start: Widths } | undefined
function startResize(event: PointerEvent, key: SortKey): void {
  if (event.button != 0) return
  // No text selected, no sort: the drag is the separator's
  event.preventDefault()
  event.stopPropagation()
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  drag = { key, x: event.clientX, start: measure() }
}
function moveResize(event: PointerEvent): void {
  if (drag) resize(drag.start, drag.key, event.clientX - drag.x)
}
function endResize(): void {
  if (!drag) return
  drag = undefined
  rememberWidths()
}
function keyResize(event: KeyboardEvent, key: SortKey): void {
  const step = event.key == 'ArrowLeft' ? -16 : event.key == 'ArrowRight' ? 16 : 0
  if (!step) return
  event.preventDefault()
  event.stopPropagation()
  resize(measure(), key, step)
  rememberWidths()
}
/** A double click on a separator: the default widths again */
function resetColumns(): void {
  widths.value = undefined
  rememberWidths()
}

const rows = computed(() =>
  visible.value.map(project => ({ project, status: projectStatus(project), files: fileCounts(project) })),
)

/** The rows are the table's active descendants: the focus stays on the table, the selected row is the one read */
const uid = useId()
const rowId = (id: ProjectId): string => `${uid}-${id}`
const active = computed(() =>
  rows.value.some(r => r.project.id == app.selectedId) && app.selectedId ? rowId(app.selectedId) : undefined,
)
// The selected row stays in view, whatever moved it (the keys, the tray, a new project)
watch(
  () => app.selectedId,
  async id => {
    await nextTick()
    if (id) document.getElementById(rowId(id))?.scrollIntoView({ block: 'nearest' })
  },
)

function sortBy(key: SortKey): void {
  if (app.sort.key == key) app.sort.dir = app.sort.dir > 0 ? -1 : 1
  else app.sort = { key, dir: 1 }
}
const sortOf = (key: SortKey): 'ascending' | 'descending' | 'none' =>
  app.sort.key == key ? (app.sort.dir > 0 ? 'ascending' : 'descending') : 'none'

function onKey(event: KeyboardEvent): void {
  // The header's buttons keep their keys
  if (event.target != root.value) return
  const page = Math.max(1, Math.floor((body.value?.clientHeight ?? ROW_HEIGHT) / ROW_HEIGHT) - 1)
  const steps: Partial<Record<string, number>> = {
    ArrowDown: 1,
    ArrowUp: -1,
    PageDown: page,
    PageUp: -page,
    Home: -Infinity,
    End: Infinity,
  }
  const step = steps[event.key]
  if (!step || event.altKey || event.ctrlKey || event.metaKey) return
  event.preventDefault()
  moveSelection(step)
}

function openMenu(id: ProjectId, x: number, y: number): void {
  select(id)
  app.menu = { id, x, y }
}
/** The right button on a row, or the menu key (Maiusc+F10) on the table: the menu of the selected row, beside it */
function onContextMenu(event: MouseEvent): void {
  event.preventDefault()
  const row = (event.target as HTMLElement).closest<HTMLElement>('[role=row][data-id]')
  if (row?.dataset.id) return openMenu(row.dataset.id, event.clientX, event.clientY)
  if (event.target != root.value || !app.selectedId) return
  const box = document.getElementById(rowId(app.selectedId))?.getBoundingClientRect()
  if (box) openMenu(app.selectedId, box.left + 40, box.top + box.height / 2)
}
const muted = (key: string): boolean => key == 'done' || key == 'never' || key == 'offline'
</script>

<template>
  <div
    ref="root"
    class="flex min-h-0 flex-col outline-none focus-visible:focus-ring-inset"
    tabindex="0"
    role="grid"
    aria-readonly="true"
    :aria-label="t('table.label')"
    :aria-rowcount="rows.length + 1"
    :aria-activedescendant="active"
    @keydown="onKey"
    @contextmenu="onContextMenu"
  >
    <div ref="body" class="min-h-0 flex-1 overflow-auto">
      <!-- As wide as the columns: when they do not fit, header and rows scroll sideways together -->
      <div :style="{ minWidth: `${minWidth}px` }">
        <div
          role="row"
          aria-rowindex="1"
          class="sticky top-0 z-20 grid h-[33px] border-b border-line bg-box"
          :style="{ gridTemplateColumns: template }"
        >
          <div
            v-for="column in columns"
            :key="column.key"
            role="columnheader"
            :data-key="column.key"
            :aria-sort="sortOf(column.key)"
            class="relative flex min-w-0"
          >
            <button
              v-tooltip="column.key == 'status' ? t(column.label) : undefined"
              type="button"
              class="flex min-w-0 flex-1 items-center gap-xs px-sm text-left text-xs font-medium hover:bg-text/[.04]"
              :class="app.sort.key == column.key ? 'text-text' : 'text-secondary'"
              @click="sortBy(column.key)"
            >
              <span v-if="column.key != 'status'" class="truncate">{{ t(column.label) }}</span>
              <AppIcon
                v-if="app.sort.key == column.key"
                :icon="app.sort.dir > 0 ? faChevronUp : faChevronDown"
                class="text-2xs"
              />
            </button>
            <div
              v-if="resizable(column.key) && column.key != FILLER"
              role="separator"
              tabindex="0"
              aria-orientation="vertical"
              :aria-label="t('table.resize', { column: t(column.label) })"
              :aria-valuenow="sizes[column.key]"
              :aria-valuemin="MIN_WIDTH[column.key]"
              class="group absolute -right-[5px] top-0 z-10 flex h-full w-[10px] cursor-col-resize touch-none justify-center outline-none"
              @pointerdown="startResize($event, column.key)"
              @pointermove="moveResize"
              @pointerup="endResize"
              @pointercancel="endResize"
              @lostpointercapture="endResize"
              @click.stop
              @dblclick.stop="resetColumns"
              @keydown="keyResize($event, column.key)"
            >
              <span
                class="my-sm w-px bg-line group-hover:my-0 group-hover:w-[2px] group-hover:bg-accent group-focus-visible:my-0 group-focus-visible:w-[2px] group-focus-visible:bg-accent group-active:my-0 group-active:w-[2px] group-active:bg-accent"
              />
            </div>
          </div>
        </div>
        <div role="rowgroup">
          <div
            v-for="({ project, status, files }, n) in rows"
            :id="rowId(project.id)"
            :key="project.id"
            role="row"
            :data-id="project.id"
            :aria-rowindex="n + 2"
            :aria-selected="project.id == app.selectedId"
            class="grid h-[37px] scroll-mt-[33px] items-center border-b border-box-soft"
            :class="project.id == app.selectedId ? 'bg-accent-soft' : 'hover:bg-text/[.03]'"
            :style="{ gridTemplateColumns: template }"
            @mousedown="select(project.id)"
          >
            <div role="gridcell" class="flex pl-sm">
              <StatusTag compact :tone="status.tone" :icon="statusIcon(status)" :label="statusLabel(status)" />
            </div>
            <div
              role="gridcell"
              class="truncate px-sm text-sm"
              :class="project.id == app.selectedId ? 'font-medium' : ''"
            >
              {{ project.label }}
            </div>
            <div role="gridcell" class="flex min-w-0 items-center gap-xs-sm px-sm text-secondary">
              <AppIcon :icon="KIND_ICONS[kindOf(project)]" />
              <span v-tooltip="project.folder" class="truncate text-xs">{{ project.folder }}</span>
            </div>
            <div role="gridcell" class="flex min-w-0 items-center gap-xs-sm px-sm text-xs">
              <template v-if="status.key == 'downloading' || status.key == 'finishing' || status.key == 'stopping'">
                <ProgressBar
                  class="min-w-0 flex-1"
                  :value="status.progress ?? 0"
                  :name="t('table.progress')"
                  :tone="status.key == 'stopping' ? 'warning' : 'accent'"
                  :lined="project.id == app.selectedId"
                />
                <span v-if="status.key != 'stopping'" class="min-w-[46px] shrink-0 text-secondary">{{
                  formatEtaShort(project.runtime.progress?.eta_seconds)
                }}</span>
              </template>
              <template v-else-if="status.key == 'listing' || status.key == 'comparing'">
                <UiSpinner class="text-accent-fg" />
                <span class="truncate">{{ statusText(project, status) }}</span>
              </template>
              <span v-else class="truncate" :class="muted(status.key) ? 'text-secondary' : ''">{{
                statusText(project, status)
              }}</span>
            </div>
            <div role="gridcell" class="tabular truncate px-sm text-xs">
              {{
                files
                  ? files[1] != null
                    ? `${formatNumber(files[0])} / ${formatNumber(files[1])}`
                    : formatNumber(files[0])
                  : '—'
              }}
            </div>
            <div
              v-if="shows('speed')"
              role="gridcell"
              class="tabular truncate px-sm text-xs"
              :class="project.runtime.phase == 'downloading' ? '' : 'text-secondary'"
            >
              {{
                project.runtime.phase == 'downloading' && project.runtime.progress
                  ? formatSpeed(project.runtime.progress.speed_bps)
                  : '—'
              }}
            </div>
            <div role="gridcell" class="truncate px-sm text-xs text-secondary">
              {{ formatWhen(project.runtime.last_result?.ended_at) || t('table.never') }}
            </div>
          </div>
        </div>
      </div>
      <div
        v-if="!rows.length && app.projects.length"
        class="flex flex-col items-center gap-lg px-lg py-3xl text-center"
      >
        <p class="text-xl text-secondary">{{ t('table.no_results') }}</p>
        <UiButton size="sm" @click="showAll">{{ t('table.show_all') }}</UiButton>
      </div>
    </div>
  </div>
</template>
