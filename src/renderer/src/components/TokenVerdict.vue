<script setup lang="ts">
/** What the check of a token found: the On Page project and how many collections have files, or why it fails */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TokenCheck } from '@shared/models'
import { formatNumber } from '../lib/format'
import { TONE_FG, TONE_ICON, TONE_SOFT, toneText } from '../lib/status-view'
import AppIcon from './ui/AppIcon.vue'

const props = defineProps<{ check: TokenCheck }>()
const { t } = useI18n()
const tone = computed(() => (props.check.ok ? 'success' : 'danger'))
</script>

<template>
  <div
    class="flex items-start gap-sm-md rounded-md px-md py-sm"
    :class="[TONE_SOFT[tone], toneText(tone)]"
    role="status"
  >
    <AppIcon :icon="TONE_ICON[tone]" class="mt-[3px]" :class="check.ok ? TONE_FG[tone] : ''" />
    <div v-if="check.ok" class="min-w-0">
      <div class="text-sm font-medium leading-normal">
        {{ t('wizard.ok_title', { label: check.project_label ?? '' }) }}
      </div>
      <div class="text-xs">
        {{
          t(
            'wizard.ok_text',
            { count: formatNumber(check.collections_with_files ?? 0) },
            check.collections_with_files ?? 0,
          )
        }}
        <template v-if="check.langs?.length"> · {{ t('wizard.langs', { langs: check.langs.join(', ') }) }}</template>
      </div>
    </div>
    <div v-else class="min-w-0">
      <div class="text-sm font-medium leading-normal">
        {{ t(`wizard.error.${check.error ?? 'token_invalid'}.title`) }}
      </div>
      <div class="text-xs">{{ t(`wizard.error.${check.error ?? 'token_invalid'}.text`) }}</div>
    </div>
  </div>
</template>
