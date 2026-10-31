<script setup lang="ts">
/**
 * The inspector under the table: the divider that resizes it, the tabs
 * (OpTabGroup compact, with the counts of failed files and duplicates) and the
 * open tab. Until it is resized it takes what the table leaves (`height`
 * undefined); `resized` says when a drag ends, to remember the height.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { InspectorTab } from '@shared/desktop-api'
import type { ProjectView } from '@shared/models'
import { formatNumber } from '../lib/format'
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

const root = ref<HTMLElement>()
const width = ref(860)
const observer = new ResizeObserver(([entry]) => (width.value = entry.contentRect.width))
onMounted(() => root.value && observer.observe(root.value))
onBeforeUnmount(() => observer.disconnect())

function resize(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  const start = event.clientY
  const from = height.value ?? root.value?.clientHeight ?? 0
  const max = (root.value?.parentElement?.clientHeight ?? 600) - 120
  const move = (e: PointerEvent): void => {
    height.value = Math.round(Math.min(max, Math.max(160, from + start - e.clientY)))
  }
  const up = (): void => {
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', up)
    emit('resized')
  }
  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', up)
}

const counts = computed(() => {
  const { issues, progress, plan, last_result } = props.project.runtime
  const failed = progress
    ? progress.failed
    : (issues.find(i => i.code == 'failed_files')?.count ?? app.failed[props.project.id]?.total ?? last_result?.failed ?? 0)
  const duplicates = issues.find(i => i.code == 'duplicates')?.count ?? plan?.duplicates ?? 0
  return { failed: [failed, 'bg-danger-soft'], duplicates: [duplicates, 'bg-warning-soft'] } as Partial<Record<InspectorTab, [number, string]>>
})
</script>

<template>
  <section
    ref="root"
    class="flex flex-col"
    :class="height ? 'shrink-0' : 'min-h-[160px] flex-1'"
    :style="height ? { height: `${height}px` } : undefined"
  >
    <div
      class="flex h-2 shrink-0 cursor-row-resize items-center justify-center border-b border-line bg-box-soft"
      role="separator"
      aria-orientation="horizontal"
      @pointerdown="resize"
    >
      <span class="h-[3px] w-7 rounded-full bg-disabled" />
    </div>
    <div role="tablist" class="flex h-[37px] shrink-0 items-end gap-xs border-b border-line px-sm">
      <button
        v-for="tab in TABS"
        :key="tab"
        type="button"
        role="tab"
        :aria-selected="app.tab == tab"
        class="flex flex-col gap-[6px]"
        @click="app.tab = tab"
      >
        <span class="flex items-center gap-[6px] px-sm text-xs font-medium" :class="app.tab == tab ? 'text-accent-fg' : 'hover:text-accent-fg'">
          {{ t(`tabs.${tab}`) }}
          <span v-if="counts[tab]?.[0]" class="tabular rounded-full px-[6px] py-px text-xs leading-[14px] text-text" :class="counts[tab]?.[1]">
            {{ formatNumber(counts[tab]?.[0] ?? 0) }}
          </span>
        </span>
        <span class="h-[2px] w-full rounded-full" :class="app.tab == tab ? 'bg-accent-fg' : ''" />
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-auto px-lg py-md">
      <GeneralTab v-if="app.tab == 'general'" :project="project" :width="width" />
      <ActivityTab v-else-if="app.tab == 'activity'" :project="project" />
      <FailedTab v-else-if="app.tab == 'failed'" :project="project" />
      <DuplicatesTab v-else-if="app.tab == 'duplicates'" :project="project" />
      <ProjectSettingsTab v-else :project="project" />
    </div>
  </section>
</template>
