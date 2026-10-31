<script setup lang="ts">
/** OpStepper: the steps in a row; done with their check, the current a disc of the accent's -fg, the next ones grey */
import { useI18n } from 'vue-i18n'
import { faCheck } from '../../lib/icons'
import AppIcon from './AppIcon.vue'

defineProps<{ steps: string[]; current: number; done?: number[] }>()
const { t } = useI18n()
</script>

<template>
  <nav class="flex items-center gap-xs" :aria-label="t('wizard.steps_label')">
    <template v-for="(label, n) in steps" :key="label">
      <span v-if="n" class="h-[1.5px] w-[14px] bg-line" />
      <span class="flex items-center gap-sm p-xs" :aria-current="n == current ? 'step' : undefined">
        <span
          v-if="n != current && (n < current || done?.includes(n))"
          class="flex h-4 w-4 items-center justify-center rounded-full bg-accent-soft text-[9px] text-accent-fg"
        >
          <AppIcon :icon="faCheck" />
        </span>
        <span
          v-else
          class="flex h-4 w-4 items-center justify-center rounded-full text-2xs font-bold"
          :class="n == current ? 'bg-accent-fg text-box' : 'border-[1.5px] border-disabled text-disabled'"
        >
          {{ n + 1 }}
        </span>
        <span
          class="text-xs font-medium"
          :class="
            n == current ? 'text-accent-fg' : n < current || done?.includes(n) ? 'text-secondary' : 'text-disabled'
          "
        >
          {{ label }}
        </span>
      </span>
    </template>
  </nav>
</template>
