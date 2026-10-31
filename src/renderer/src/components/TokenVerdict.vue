<script setup lang="ts">
/** What the check of a token found: the On Page project and how many collections have files, or why it fails */
import { useI18n } from 'vue-i18n'
import type { TokenCheck } from '@shared/models'
import { formatNumber } from '../lib/format'
import * as icons from '../lib/icons'
import AppIcon from './ui/AppIcon.vue'

defineProps<{ check: TokenCheck }>()
const { t } = useI18n()
</script>

<template>
  <div
    class="flex items-start gap-[10px] rounded-md px-md py-sm"
    :class="check.ok ? 'bg-success-soft' : 'bg-danger-soft text-danger-fg'"
    role="status"
  >
    <AppIcon :icon="check.ok ? icons.faCircleCheck : icons.faCircleExclamation" class="mt-[3px]" :class="check.ok ? 'text-success-fg' : ''" />
    <div v-if="check.ok" class="min-w-0">
      <div class="text-sm font-medium leading-[21px]">{{ t('wizard.ok_title', { label: check.project_label ?? '' }) }}</div>
      <div class="text-xs">
        {{ t('wizard.ok_text', { count: formatNumber(check.collections_with_files ?? 0) }, check.collections_with_files ?? 0) }}
        <template v-if="check.langs?.length"> · {{ t('wizard.langs', { langs: check.langs.join(', ') }) }}</template>
      </div>
    </div>
    <div v-else class="min-w-0">
      <div class="text-sm font-medium leading-[21px]">{{ t(`wizard.error.${check.error ?? 'token_invalid'}.title`) }}</div>
      <div class="text-xs">{{ t(`wizard.error.${check.error ?? 'token_invalid'}.text`) }}</div>
    </div>
  </div>
</template>
