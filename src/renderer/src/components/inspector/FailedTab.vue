<script setup lang="ts">
/** «Falliti»: each file with why it failed and how many times it was tried; «Riprova i falliti» on top */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ProjectView } from '@shared/models'
import { formatBytes, formatNumber } from '../../lib/format'
import * as icons from '../../lib/icons'
import { app, retryFailed } from '../../store'
import AppIcon from '../ui/AppIcon.vue'
import UiButton from '../ui/UiButton.vue'

const props = defineProps<{ project: ProjectView }>()
const { t } = useI18n()
const failed = computed(() => app.failed[props.project.id] ?? [])
</script>

<template>
  <div class="flex flex-col gap-md">
    <div class="flex items-center gap-sm">
      <span class="text-sm font-medium">
        {{ t(project.runtime.phase == 'idle' ? 'failed.summary' : 'failed.summary_running', { count: formatNumber(failed.length) }, failed.length) }}
      </span>
      <span class="flex-1" />
      <UiButton :icon="icons.faArrowsRotate" :disabled="!failed.length || project.runtime.phase != 'idle'" @click="retryFailed(project.id)">
        {{ t('failed.retry_all') }}
      </UiButton>
    </div>
    <ul v-if="failed.length" class="overflow-hidden rounded-md border border-line bg-box">
      <li v-for="entry in failed" :key="entry.token + entry.name" class="flex items-center gap-[10px] border-b border-line py-sm pl-md pr-sm last:border-b-0">
        <AppIcon :icon="icons.faCircleExclamation" class="text-danger-fg" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm leading-[19px]">{{ entry.name }}</div>
          <div v-tooltip="entry.detail" class="truncate text-xs text-secondary first-letter:uppercase">{{ t(`reason.${entry.reason}`) }}</div>
        </div>
        <span class="tabular shrink-0 text-xs text-secondary">{{ entry.size != null ? formatBytes(entry.size) : '—' }}</span>
        <span class="w-[90px] shrink-0 text-right text-xs text-secondary">{{ t('failed.attempts', { count: entry.attempts }, entry.attempts) }}</span>
      </li>
    </ul>
    <p v-else class="py-xl text-center text-secondary">{{ t('failed.empty') }}</p>
  </div>
</template>
