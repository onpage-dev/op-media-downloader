<script setup lang="ts">
/** The status bar: connected, how many run and how fast, the files and the space on disk; the version and its update */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatBytes, formatNumber, formatSpeed } from '../lib/format'
import * as icons from '../lib/icons'
import { app, openRelease } from '../store'
import AppIcon from './ui/AppIcon.vue'

const { t } = useI18n()
const status = computed(() => app.status)
const update = computed(() => {
  const v = app.version
  return v?.latest && v.latest != v.current ? v.latest : undefined
})
</script>

<template>
  <footer class="flex h-7 shrink-0 items-center gap-md border-t border-line px-md text-xs">
    <span class="flex items-center gap-[6px]">
      <span class="h-[7px] w-[7px] rounded-full" :class="status?.online === false ? 'bg-neutral' : 'bg-success'" />
      {{ status?.online === false ? t('status_bar.offline') : t('status_bar.online') }}
    </span>
    <template v-if="app.projects.length && status">
      <span class="flex items-center gap-xs text-secondary">
        <AppIcon :icon="icons.faArrowsRotate" class="text-[12px]" />
        {{ t('status_bar.running', { count: formatNumber(status.running_jobs) }) }}
      </span>
      <span class="tabular flex items-center gap-xs text-secondary">
        <AppIcon :icon="icons.faArrowDownToBracket" class="text-[12px]" />
        {{ status.running_jobs ? formatSpeed(status.speed_bps) : '—' }}
      </span>
      <span class="tabular flex items-center gap-xs text-secondary">
        <AppIcon :icon="icons.faFileLines" class="text-[12px]" />
        {{ t('status_bar.files', { count: formatNumber(status.total_files) }) }}
      </span>
      <span class="tabular flex items-center gap-xs text-secondary">
        <AppIcon :icon="icons.faHardDrive" class="text-[12px]" />
        {{ formatBytes(status.total_bytes) }}
      </span>
    </template>
    <span v-else class="text-secondary">{{ t('status_bar.empty') }}</span>
    <span class="flex-1" />
    <span v-if="app.version" class="text-secondary">v{{ app.version.current.replace(/^v/, '') }}</span>
    <button v-if="update" type="button" class="flex items-center gap-xs font-medium text-accent-fg hover:underline" @click="openRelease">
      <AppIcon :icon="icons.faArrowDownToBracket" class="text-[12px]" />
      {{ t('status_bar.update', { version: `v${update.replace(/^v/, '')}` }) }}
    </button>
  </footer>
</template>
