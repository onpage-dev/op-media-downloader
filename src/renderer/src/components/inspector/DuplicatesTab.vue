<script setup lang="ts">
/**
 * «Duplicati»: the names that have different files on On Page, a row per file
 * with where it is used (links to On Page) and its size; the one downloaded
 * is the first found. A project can have tens of thousands: they come a page
 * at a time while scrolling, and can be searched by name (each project its own
 * search: the tab starts again with another project).
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ProjectView } from '@shared/models'
import { formatNumber } from '../../lib/format'
import * as icons from '../../lib/icons'
import { app, loadMore, reloadList, searchDuplicates, sync } from '../../store'
import SearchField from '../ui/SearchField.vue'
import UiButton from '../ui/UiButton.vue'
import DuplicateRows from './DuplicateRows.vue'
import LongList from './LongList.vue'

const props = defineProps<{ project: ProjectView }>()
const { t } = useI18n()
const list = computed(() => app.duplicates[props.project.id])

const query = ref(list.value?.query ?? '')
let typing: number | undefined
watch(query, value => {
  window.clearTimeout(typing)
  typing = window.setTimeout(() => void searchDuplicates(props.project.id, value.trim()), 250)
})
onBeforeUnmount(() => window.clearTimeout(typing))
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
      <SearchField
        v-model="query"
        class="w-[240px] shrink-0"
        :placeholder="t('duplicates.search')"
        :clear-label="t('common.close')"
      />
      <span v-if="list.language_variants" class="min-w-0 truncate text-xs text-secondary">
        {{ t('duplicates.languages', { count: formatNumber(list.language_variants) }, list.language_variants) }}
      </span>
    </div>
    <LongList
      v-slot="{ items }"
      :list="list"
      :empty="list?.query ? t('duplicates.no_results') : t('duplicates.empty')"
      @more="loadMore('duplicates', project.id)"
      @retry="reloadList('duplicates', project.id)"
    >
      <DuplicateRows :groups="items" />
    </LongList>
  </div>
</template>
