<script setup lang="ts">
/** The filters on the left, as in a torrent client: the states with their counts, then the destinations */
import { useI18n } from 'vue-i18n'
import type { ProjectFilter, StatusTone } from '@shared/status'
import * as icons from '../lib/icons'
import { KIND_ICONS, TONE_FG } from '../lib/status-view'
import { app, counts, DESTINATIONS } from '../store'
import AppIcon from './ui/AppIcon.vue'

const { t } = useI18n()
const STATES: [ProjectFilter, icons.IconDefinition, StatusTone | undefined][] = [
  ['all', icons.faList, undefined],
  ['running', icons.faArrowsRotate, 'accent'],
  ['todo', icons.faArrowDownToBracket, 'info'],
  ['errors', icons.faCircleExclamation, 'danger'],
  ['done', icons.faCircleCheck, 'success'],
  ['never', icons.faClock, 'neutral'],
]
</script>

<template>
  <aside class="flex w-sidebar shrink-0 flex-col gap-2xs overflow-auto px-sm pb-sm pt-xs">
    <h2 class="px-sm pb-xs pt-sm text-xs font-medium text-secondary">{{ t('filters.state') }}</h2>
    <button
      v-for="[filter, icon, tone] in STATES"
      :key="filter"
      type="button"
      class="flex items-center gap-sm rounded-md px-sm py-[7px] text-left text-sm"
      :class="app.filter == filter ? 'bg-accent-soft font-medium text-accent-fg' : 'hover:bg-tint'"
      :aria-pressed="app.filter == filter"
      @click="app.filter = filter"
    >
      <AppIcon :icon="icon" :class="app.filter == filter ? '' : tone ? TONE_FG[tone] : ''" />
      <span class="flex-1">{{ t(`filters.${filter}`) }}</span>
      <span class="tabular text-xs" :class="app.filter == filter ? '' : 'text-secondary'">{{ counts[filter] }}</span>
    </button>
    <h2 class="px-sm pb-xs pt-[18px] text-xs font-medium text-secondary">{{ t('filters.destinations') }}</h2>
    <button
      v-for="kind in DESTINATIONS"
      :key="kind"
      type="button"
      class="flex items-center gap-sm rounded-md px-sm py-[7px] text-left text-sm"
      :class="app.kind == kind ? 'bg-accent-soft font-medium text-accent-fg' : 'hover:bg-tint'"
      :aria-pressed="app.kind == kind"
      @click="app.kind = app.kind == kind ? undefined : kind"
    >
      <AppIcon :icon="KIND_ICONS[kind]" />
      <span class="flex-1">{{ t(`filters.${kind}`) }}</span>
      <span class="tabular text-xs" :class="app.kind == kind ? '' : 'text-secondary'">{{ counts[kind] }}</span>
    </button>
  </aside>
</template>
