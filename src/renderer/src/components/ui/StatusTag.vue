<script setup lang="ts">
/**
 * A state as OpStatusTag: the tone's soft, its icon (or a dot) in the tone's
 * -fg, the label in the text's colour; `compact` is the circle alone, the
 * label in its tooltip, for a narrow column.
 */
import type { StatusTone } from '@shared/status'
import type { IconDefinition } from '../../lib/icons'
import { TONE_DOT, TONE_FG, TONE_SOFT } from '../../lib/status-view'
import AppIcon from './AppIcon.vue'

defineProps<{ tone: StatusTone; label: string; icon?: IconDefinition; dot?: boolean; compact?: boolean }>()
</script>

<template>
  <span
    v-if="compact"
    v-tooltip="label"
    role="img"
    :aria-label="label"
    class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px]"
    :class="[TONE_SOFT[tone], TONE_FG[tone]]"
  >
    <AppIcon v-if="icon" :icon="icon" />
    <span v-else class="h-[7px] w-[7px] rounded-full" :class="TONE_DOT[tone]" />
  </span>
  <span v-else class="inline-flex h-6 shrink-0 items-center gap-xs whitespace-nowrap rounded-full px-sm text-xs" :class="TONE_SOFT[tone]">
    <AppIcon v-if="icon" :icon="icon" class="text-[11px]" :class="TONE_FG[tone]" />
    <span v-else-if="dot" class="h-[7px] w-[7px] rounded-full" :class="TONE_DOT[tone]" />
    {{ label }}
  </span>
</template>
