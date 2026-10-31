<script setup lang="ts">
/**
 * «Duplicati»: the names that have different files on On Page, a row per file
 * with where it is used (links to On Page) and its size; the one downloaded
 * is the first found.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DuplicateUse, DuplicateVariant, ProjectView } from '@shared/models'
import { formatBytes } from '../../lib/format'
import * as icons from '../../lib/icons'
import { app, sync } from '../../store'
import AppIcon from '../ui/AppIcon.vue'
import StatusTag from '../ui/StatusTag.vue'
import UiButton from '../ui/UiButton.vue'

const props = defineProps<{ project: ProjectView }>()
const { t } = useI18n()
const groups = computed(() => app.duplicates[props.project.id] ?? [])
const size = (v: DuplicateVariant): string =>
  [v.width && v.height ? `${v.width}×${v.height}` : '', v.size != null ? formatBytes(v.size) : ''].filter(Boolean).join(' · ')
const open = (use: DuplicateUse): Promise<void> => window.desktop.app.openExternal(use.edit_url)
</script>

<template>
  <div class="flex flex-col gap-md">
    <div class="flex items-center gap-sm">
      <p class="min-w-0 flex-1 text-xs text-secondary">{{ t('duplicates.rule') }}</p>
      <UiButton :icon="icons.faArrowsRotate" :disabled="project.runtime.phase != 'idle'" @click="sync(project.id)">
        {{ t('duplicates.refresh') }}
      </UiButton>
    </div>
    <ul v-if="groups.length" class="overflow-hidden rounded-md border border-line bg-box">
      <template v-for="group in groups" :key="group.name">
        <li v-for="(variant, n) in group.variants" :key="variant.token" class="flex items-center gap-[10px] border-b border-line px-md py-[6px] last:border-b-0">
          <span class="w-[150px] shrink-0 truncate text-sm font-medium">{{ n ? '' : group.name }}</span>
          <span class="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-box-soft text-secondary">
            <img v-if="variant.thumb_url" :src="variant.thumb_url" class="h-full w-full object-cover" alt="" />
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
    <p v-else class="py-xl text-center text-secondary">{{ t('duplicates.empty') }}</p>
  </div>
</template>
