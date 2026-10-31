<script setup lang="ts">
/**
 * «Falliti»: each file with why it failed and how many times it was tried;
 * «Riprova i falliti» on top. When the network goes down halfway they can
 * be tens of thousands: they come a page at a time while scrolling.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ProjectView } from '@shared/models'
import { formatBytes, formatNumber } from '../../lib/format'
import * as icons from '../../lib/icons'
import { app, loadMore, reloadList, retryFailed } from '../../store'
import AppIcon from '../ui/AppIcon.vue'
import UiButton from '../ui/UiButton.vue'
import UiSpinner from '../ui/UiSpinner.vue'

const props = defineProps<{ project: ProjectView }>()
const { t } = useI18n()
const list = computed(() => app.failed[props.project.id])
const failed = computed(() => list.value?.items ?? [])
const total = computed(() => list.value?.total ?? 0)

const end = ref<HTMLElement>()
const observer = new IntersectionObserver(
  entries => {
    if (entries.some(e => e.isIntersecting)) void loadMore('failed', props.project.id)
  },
  { rootMargin: '600px' },
)
watch(end, (now, before) => {
  if (before) observer.unobserve(before)
  if (now) observer.observe(now)
})
onBeforeUnmount(() => observer.disconnect())
</script>

<template>
  <div class="flex flex-col gap-md">
    <div class="flex items-center gap-sm">
      <span class="text-sm font-medium">
        {{ t(project.runtime.phase == 'idle' ? 'failed.summary' : 'failed.summary_running', { count: formatNumber(total) }, total) }}
      </span>
      <span class="flex-1" />
      <UiButton :icon="icons.faArrowsRotate" :disabled="!total || project.runtime.phase != 'idle'" @click="retryFailed(project.id)">
        {{ t('failed.retry_all') }}
      </UiButton>
    </div>
    <ul v-if="failed.length" class="overflow-hidden rounded-md border border-line bg-box">
      <li
        v-for="entry in failed"
        :key="entry.token + entry.name"
        class="flex items-center gap-[10px] border-b border-line py-sm pl-md pr-sm [contain-intrinsic-size:auto_52px] [content-visibility:auto] last:border-b-0"
      >
        <AppIcon :icon="icons.faCircleExclamation" class="text-danger-fg" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm leading-[19px]">{{ entry.name }}</div>
          <div v-tooltip="entry.detail" class="truncate text-xs text-secondary first-letter:uppercase">{{ t(`reason.${entry.reason}`) }}</div>
        </div>
        <span class="tabular shrink-0 text-xs text-secondary">{{ entry.size != null ? formatBytes(entry.size) : '—' }}</span>
        <span class="w-[90px] shrink-0 text-right text-xs text-secondary">{{ t('failed.attempts', { count: entry.attempts }, entry.attempts) }}</span>
      </li>
    </ul>
    <div v-if="!list || list.loading" class="flex items-center justify-center gap-sm py-lg text-secondary" role="status">
      <UiSpinner />
      {{ t('common.loading') }}
    </div>
    <div v-else-if="list.error" class="flex flex-col items-center gap-sm py-xl text-secondary">
      {{ t('common.load_error') }}
      <UiButton :icon="icons.faArrowsRotate" @click="reloadList('failed', project.id)">{{ t('common.retry') }}</UiButton>
    </div>
    <p v-else-if="!failed.length" class="py-xl text-center text-secondary">{{ t('failed.empty') }}</p>
    <div ref="end" class="h-px shrink-0" />
  </div>
</template>
