<script setup lang="ts">
/**
 * The inspector under the table: the divider that resizes it (dragged, or with
 * ↑ ↓ Home End once it has the focus), the tabs (OpTabGroup compact, with the
 * counts of failed files and duplicates; ← → move between them) and the open
 * tab. Until it is resized it takes what the table leaves (`height`
 * undefined); `resized` says when a resize ends, to remember the height. A
 * remembered height larger than the window allows is shown smaller, and comes
 * back when the window grows.
 */
import { computed, onBeforeUnmount, onMounted, provide, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import type { InspectorTab } from '@shared/desktop-api'
import type { ProjectView } from '@shared/models'
import { SCROLLER } from '../composables/useInfiniteScroll'
import { formatNumber } from '../lib/format'
import { TONE_SOFT } from '../lib/status-view'
import { app } from '../store'
import ActivityTab from './inspector/ActivityTab.vue'
import DuplicatesTab from './inspector/DuplicatesTab.vue'
import FailedTab from './inspector/FailedTab.vue'
import GeneralTab from './inspector/GeneralTab.vue'
import ProjectSettingsTab from './inspector/ProjectSettingsTab.vue'

const props = defineProps<{ project: ProjectView }>()
const height = defineModel<number>('height')
const emit = defineEmits<{ resized: [] }>()
const { t } = useI18n()
const TABS: InspectorTab[] = ['general', 'activity', 'failed', 'duplicates', 'settings']
/** The inspector's least height, and what it leaves to the table at least */
const MIN = 160
const TABLE_MIN = 120
const STEP = 16

const root = ref<HTMLElement>()
const scroller = ref<HTMLElement>()
provide(SCROLLER, scroller)
const width = ref(860)
const own = ref(0)
/** The height of the box the table and the inspector share */
const room = ref(600)
const observer = new ResizeObserver(entries => {
  for (const entry of entries) {
    if (entry.target == root.value) {
      width.value = entry.contentRect.width
      own.value = entry.contentRect.height
    } else room.value = entry.contentRect.height
  }
})
onMounted(() => {
  if (root.value) observer.observe(root.value)
  if (root.value?.parentElement) observer.observe(root.value.parentElement)
})
onBeforeUnmount(() => observer.disconnect())

const max = computed(() => Math.max(MIN, room.value - TABLE_MIN))
const clamp = (value: number): number => Math.round(Math.min(max.value, Math.max(MIN, value)))
/** The height drawn: the remembered one, within what the window has */
const shown = computed(() => (height.value == null ? undefined : clamp(height.value)))

/** Released, cancelled by the system (a touch turned into a gesture) or the capture lost: the drag ends, once */
const DRAG_ENDS = ['pointerup', 'pointercancel', 'lostpointercapture'] as const
function resize(event: PointerEvent): void {
  if (event.button != 0) return
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  const start = event.clientY
  const from = shown.value ?? own.value
  const move = (e: PointerEvent): void => {
    height.value = clamp(from + start - e.clientY)
  }
  const end = (): void => {
    target.removeEventListener('pointermove', move)
    for (const name of DRAG_ENDS) target.removeEventListener(name, end)
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
    emit('resized')
  }
  target.addEventListener('pointermove', move)
  for (const name of DRAG_ENDS) target.addEventListener(name, end)
}
/** ↑ makes the inspector taller (the divider goes up), ↓ shorter; Home and End its least and its most */
function onDividerKey(event: KeyboardEvent): void {
  const from = shown.value ?? own.value
  const heights: Partial<Record<string, number>> = {
    ArrowUp: from + STEP,
    ArrowDown: from - STEP,
    PageUp: from + 4 * STEP,
    PageDown: from - 4 * STEP,
    Home: MIN,
    End: max.value,
  }
  const next = heights[event.key]
  if (next == null) return
  event.preventDefault()
  height.value = clamp(next)
  emit('resized')
}

const uid = useId()
const tabId = (tab: InspectorTab): string => `${uid}-tab-${tab}`
const panelId = `${uid}-panel`
function onTabKey(event: KeyboardEvent): void {
  const at = TABS.indexOf(app.tab)
  const tabs: Partial<Record<string, number>> = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: TABS.length - 1 }
  const to = tabs[event.key]
  if (to == null) return
  event.preventDefault()
  app.tab = TABS[(to + TABS.length) % TABS.length]
  document.getElementById(tabId(app.tab))?.focus()
}

const counts = computed(() => {
  const { issues, progress, plan, last_result } = props.project.runtime
  const failed = progress
    ? progress.failed
    : (issues.find(i => i.code == 'failed_files')?.count ??
      app.failed[props.project.id]?.total ??
      last_result?.failed ??
      0)
  const duplicates = issues.find(i => i.code == 'duplicates')?.count ?? plan?.duplicates ?? 0
  return { failed: [failed, TONE_SOFT.danger], duplicates: [duplicates, TONE_SOFT.warning] } as Partial<
    Record<InspectorTab, [number, string]>
  >
})
</script>

<template>
  <section
    ref="root"
    class="flex flex-col"
    :class="shown ? 'shrink-0' : 'min-h-[160px] flex-1'"
    :style="shown ? { height: `${shown}px` } : undefined"
  >
    <div
      class="flex h-2 shrink-0 cursor-row-resize items-center justify-center border-b border-line bg-box-soft focus-visible:focus-ring-inset"
      role="separator"
      tabindex="0"
      aria-orientation="horizontal"
      :aria-label="t('tabs.resize')"
      :aria-valuenow="shown ?? Math.round(own)"
      :aria-valuemin="MIN"
      :aria-valuemax="max"
      @pointerdown="resize"
      @keydown="onDividerKey"
    >
      <span class="h-[3px] w-7 rounded-full bg-disabled" />
    </div>
    <div
      role="tablist"
      :aria-label="project.label"
      class="flex h-[37px] shrink-0 items-end gap-xs border-b border-line px-sm"
      @keydown="onTabKey"
    >
      <button
        v-for="tab in TABS"
        :id="tabId(tab)"
        :key="tab"
        type="button"
        role="tab"
        :aria-selected="app.tab == tab"
        :aria-controls="panelId"
        :tabindex="app.tab == tab ? 0 : -1"
        class="flex flex-col gap-xs-sm"
        @click="app.tab = tab"
      >
        <span
          class="flex items-center gap-xs-sm px-sm text-xs font-medium"
          :class="app.tab == tab ? 'text-accent-fg' : 'hover:text-accent-fg'"
        >
          {{ t(`tabs.${tab}`) }}
          <span
            v-if="counts[tab]?.[0]"
            class="tabular rounded-full px-xs-sm py-px text-xs leading-[14px] text-text"
            :class="counts[tab]?.[1]"
          >
            {{ formatNumber(counts[tab]?.[0] ?? 0) }}
          </span>
        </span>
        <span class="h-[2px] w-full rounded-full" :class="app.tab == tab ? 'bg-accent-fg' : ''" />
      </button>
    </div>
    <div
      :id="panelId"
      ref="scroller"
      role="tabpanel"
      :aria-labelledby="tabId(app.tab)"
      tabindex="0"
      class="min-h-0 flex-1 overflow-auto px-lg py-md focus-visible:focus-ring-inset"
    >
      <GeneralTab v-if="app.tab == 'general'" :key="`general-${project.id}`" :project="project" :width="width" />
      <ActivityTab v-else-if="app.tab == 'activity'" :key="`activity-${project.id}`" :project="project" />
      <FailedTab v-else-if="app.tab == 'failed'" :key="`failed-${project.id}`" :project="project" />
      <DuplicatesTab v-else-if="app.tab == 'duplicates'" :key="`duplicates-${project.id}`" :project="project" />
      <ProjectSettingsTab v-else :key="`settings-${project.id}`" :project="project" />
    </div>
  </section>
</template>
