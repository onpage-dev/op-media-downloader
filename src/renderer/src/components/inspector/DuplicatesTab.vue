<script setup lang="ts">
/**
 * «Duplicati»: the names that have different files on On Page, a row per file
 * with where it is used (links to On Page) and its size; the one downloaded
 * is the first found. A project can have tens of thousands: they come a page
 * at a time while scrolling, and can be searched by name.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DuplicateUse, DuplicateVariant, ProjectView } from '@shared/models'
import { formatBytes, formatNumber } from '../../lib/format'
import * as icons from '../../lib/icons'
import { app, loadMore, reloadList, searchDuplicates, sync } from '../../store'
import AppIcon from '../ui/AppIcon.vue'
import SearchField from '../ui/SearchField.vue'
import StatusTag from '../ui/StatusTag.vue'
import UiButton from '../ui/UiButton.vue'
import UiSpinner from '../ui/UiSpinner.vue'

const props = defineProps<{ project: ProjectView }>()
const { t } = useI18n()
const list = computed(() => app.duplicates[props.project.id])
const groups = computed(() => list.value?.items ?? [])
const size = (v: DuplicateVariant): string =>
  [v.width && v.height ? `${v.width}×${v.height}` : '', v.size != null ? formatBytes(v.size) : ''].filter(Boolean).join(' · ')
const open = (use: DuplicateUse): Promise<void> => window.desktop.app.openExternal(use.edit_url)

const query = ref(list.value?.query ?? '')
let typing: number | undefined
watch(query, value => {
  window.clearTimeout(typing)
  typing = window.setTimeout(() => void searchDuplicates(props.project.id, value.trim()), 250)
})

// The next page when the end of the list comes into view
const end = ref<HTMLElement>()
const observer = new IntersectionObserver(
  entries => {
    if (entries.some(e => e.isIntersecting)) void loadMore('duplicates', props.project.id)
  },
  { rootMargin: '600px' },
)
watch(end, (now, before) => {
  if (before) observer.unobserve(before)
  if (now) observer.observe(now)
})
onBeforeUnmount(() => {
  observer.disconnect()
  window.clearTimeout(typing)
})
</script>

<template>
  <div class="flex flex-col gap-md">
    <div class="flex items-center gap-sm">
      <p class="min-w-0 flex-1 text-xs text-secondary">{{ t('duplicates.rule') }}</p>
      <UiButton :icon="icons.faArrowsRotate" :disabled="project.runtime.phase != 'idle'" @click="sync(project.id)">
        {{ t('duplicates.refresh') }}
      </UiButton>
    </div>
    <div v-if="list && (list.total || list.query)" class="flex items-center gap-md">
      <SearchField v-model="query" class="w-[240px] shrink-0" :placeholder="t('duplicates.search')" :clear-label="t('common.close')" />
      <span v-if="list.language_variants" class="min-w-0 truncate text-xs text-secondary">
        {{ t('duplicates.languages', { count: formatNumber(list.language_variants) }, list.language_variants) }}
      </span>
    </div>
    <ul v-if="groups.length" class="overflow-hidden rounded-md border border-line bg-box">
      <template v-for="group in groups" :key="group.name">
        <li
          v-for="(variant, n) in group.variants"
          :key="variant.token"
          class="flex items-center gap-[10px] border-b border-line px-md py-[6px] [contain-intrinsic-size:auto_40px] [content-visibility:auto] last:border-b-0"
        >
          <span class="w-[150px] shrink-0 truncate text-sm font-medium">{{ n ? '' : group.name }}</span>
          <span class="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-box-soft text-secondary">
            <img v-if="variant.thumb_url" :src="variant.thumb_url" loading="lazy" decoding="async" class="h-full w-full object-cover" alt="" />
            <AppIcon v-else :icon="icons.faFileImage" />
          </span>
          <span class="flex min-w-0 flex-1 flex-wrap gap-x-sm text-xs">
            <button
              v-for="use in variant.uses"
              :key="`${use.thing_id}${use.lang ?? ''}${use.field_label}`"
              type="button"
              class="truncate text-accent-fg hover:underline"
              @click="open(use)"
            >
              {{ use.resource_label }} › {{ use.field_label }} · {{ use.thing_label }} #{{ use.thing_id }}{{ use.lang ? ` (${use.lang})` : '' }}
            </button>
          </span>
          <span class="tabular shrink-0 text-xs text-secondary">{{ size(variant) }}</span>
          <StatusTag
            :tone="variant.chosen ? 'success' : 'neutral'"
            :icon="variant.chosen ? icons.faCircleCheck : icons.faXmark"
            :label="variant.chosen ? t('duplicates.chosen') : t('duplicates.skipped')"
          />
        </li>
      </template>
    </ul>
    <div v-if="!list || list.loading" class="flex items-center justify-center gap-sm py-lg text-secondary" role="status">
      <UiSpinner />
      {{ t('common.loading') }}
    </div>
    <div v-else-if="list.error" class="flex flex-col items-center gap-sm py-xl text-secondary">
      {{ t('common.load_error') }}
      <UiButton :icon="icons.faArrowsRotate" @click="reloadList('duplicates', project.id)">{{ t('common.retry') }}</UiButton>
    </div>
    <p v-else-if="!groups.length" class="py-xl text-center text-secondary">
      {{ list.query ? t('duplicates.no_results') : t('duplicates.empty') }}
    </p>
    <div ref="end" class="h-px shrink-0" />
  </div>
</template>
