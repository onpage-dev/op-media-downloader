<script setup lang="ts">
/**
 * The rows of one name of «Duplicati»: a row per file, its preview, where it
 * is used (links to On Page), its size and whether it is the one downloaded;
 * of a name with many files (thousands, for generated ones) the first ones,
 * the next ones a hundred at a time with «Mostra altri».
 * A component per name: a new page of names draws only its own rows, never
 * again the ones already shown
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DuplicateGroup, DuplicateVariant, ProjectId } from '@shared/models'
import { formatBytes, formatNumber } from '../../lib/format'
import * as icons from '../../lib/icons'
import { openOnPage, showMoreVariants } from '../../store'
import AppIcon from '../ui/AppIcon.vue'
import StatusTag from '../ui/StatusTag.vue'

const props = defineProps<{ group: DuplicateGroup; projectId: ProjectId }>()
const { t } = useI18n()

const more = computed(() => props.group.more_variants ?? 0)
/** What «Mostra altri» brings: the store asks for a hundred at a time */
const next = computed(() => Math.min(more.value, 100))
const loading = ref(false)
async function showMore(): Promise<void> {
  if (loading.value) return
  loading.value = true
  try {
    await showMoreVariants(props.projectId, props.group.name)
  } finally {
    loading.value = false
  }
}
const size = (v: DuplicateVariant): string =>
  [v.width && v.height ? `${v.width}×${v.height}` : '', v.size != null ? formatBytes(v.size) : '']
    .filter(Boolean)
    .join(' · ')
</script>

<template>
  <li
    v-for="(variant, n) in group.variants"
    :key="variant.token"
    class="flex items-center gap-sm-md border-b border-line px-md py-xs-sm [contain-intrinsic-size:auto_40px] [content-visibility:auto] last:border-b-0"
  >
    <span class="w-[150px] shrink-0 truncate text-sm font-medium">{{ n ? '' : group.name }}</span>
    <span
      class="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-box-soft text-secondary"
    >
      <img
        v-if="variant.thumb_url"
        :src="variant.thumb_url"
        loading="lazy"
        decoding="async"
        class="h-full w-full object-cover"
        alt=""
      />
      <AppIcon v-else :icon="icons.faFileImage" />
    </span>
    <span class="flex min-w-0 flex-1 flex-wrap gap-x-sm text-xs">
      <button
        v-for="use in variant.uses"
        :key="`${use.thing_id}${use.lang ?? ''}${use.field_label}`"
        type="button"
        class="truncate text-accent-fg hover:underline"
        @click="openOnPage(use.edit_url)"
      >
        {{ use.resource_label }} › {{ use.field_label }} · {{ use.thing_label ? `${use.thing_label} ` : '' }}#{{
          use.thing_id
        }}{{ use.lang ? ` (${use.lang})` : '' }}
      </button>
    </span>
    <span class="tabular shrink-0 text-xs text-secondary">{{ size(variant) }}</span>
    <StatusTag
      :tone="variant.chosen ? 'success' : 'neutral'"
      :icon="variant.chosen ? icons.faCircleCheck : icons.faXmark"
      :label="variant.chosen ? t('duplicates.chosen') : t('duplicates.skipped')"
    />
  </li>
  <li
    v-if="more"
    class="flex items-center gap-sm border-b border-line py-xs-sm pl-[calc(150px+var(--spacing-md)+var(--spacing-sm-md))] pr-md text-xs text-secondary last:border-b-0"
  >
    {{ t('duplicates.more', { count: formatNumber(more) }, more) }}
    <button
      type="button"
      class="text-accent-fg hover:underline disabled:opacity-60 disabled:hover:no-underline"
      :disabled="loading"
      @click="showMore"
    >
      {{ t('duplicates.show_more', { count: formatNumber(next) }, next) }}
    </button>
  </li>
</template>
