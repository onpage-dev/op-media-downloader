<script setup lang="ts">
/**
 * The rows of «Duplicati»: a row per file of a name, its preview, where it is
 * used (links to On Page), its size and whether it is the one downloaded
 */
import { useI18n } from 'vue-i18n'
import type { DuplicateGroup, DuplicateVariant } from '@shared/models'
import { formatBytes } from '../../lib/format'
import * as icons from '../../lib/icons'
import { openOnPage } from '../../store'
import AppIcon from '../ui/AppIcon.vue'
import StatusTag from '../ui/StatusTag.vue'

defineProps<{ groups: DuplicateGroup[] }>()
const { t } = useI18n()
const size = (v: DuplicateVariant): string =>
  [v.width && v.height ? `${v.width}×${v.height}` : '', v.size != null ? formatBytes(v.size) : '']
    .filter(Boolean)
    .join(' · ')
</script>

<template>
  <template v-for="group in groups" :key="group.name">
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
          {{ use.resource_label }} › {{ use.field_label }} · {{ use.thing_label }} #{{ use.thing_id
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
  </template>
</template>
