<script setup lang="ts">
/** The rows of «Falliti»: the file, why it failed (the code in the tooltip), its size, how many times it was tried */
import { useI18n } from 'vue-i18n'
import type { FailedEntry } from '@shared/models'
import { formatBytes } from '../../lib/format'
import * as icons from '../../lib/icons'
import AppIcon from '../ui/AppIcon.vue'

defineProps<{ entries: FailedEntry[] }>()
const { t } = useI18n()
</script>

<template>
  <li
    v-for="entry in entries"
    :key="entry.token + entry.name"
    class="flex items-center gap-sm-md border-b border-line py-sm pl-md pr-sm [contain-intrinsic-size:auto_52px] [content-visibility:auto] last:border-b-0"
  >
    <AppIcon :icon="icons.faCircleExclamation" class="text-danger-fg" />
    <div class="min-w-0 flex-1">
      <div class="truncate text-sm leading-[19px]">{{ entry.name }}</div>
      <div v-tooltip="entry.detail" class="truncate text-xs text-secondary first-letter:uppercase">
        {{ t(`reason.${entry.reason}`) }}
      </div>
    </div>
    <span class="tabular shrink-0 text-xs text-secondary">{{
      entry.size != null ? formatBytes(entry.size) : '—'
    }}</span>
    <span class="w-[90px] shrink-0 text-right text-xs text-secondary">{{
      t('failed.attempts', { count: entry.attempts }, entry.attempts)
    }}</span>
  </li>
</template>
