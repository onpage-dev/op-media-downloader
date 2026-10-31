<script setup lang="ts">
/**
 * OpAlert: a condition of the section it sits in, on the tone's soft with its
 * icon; the title 14 medium, the text 12; danger and warning write in their
 * -fg. The actions on the right, or under the words.
 */
import { TONE_FG, TONE_ICON, TONE_SOFT, toneText } from '../../lib/status-view'
import AppIcon from './AppIcon.vue'

withDefaults(defineProps<{ tone: 'success' | 'info' | 'warning' | 'danger' | 'neutral'; title?: string; below?: boolean }>(), {
  below: false,
})
</script>

<template>
  <div class="flex gap-sm rounded-xl p-lg" :class="[TONE_SOFT[tone], below ? 'items-start' : 'items-center']" role="status">
    <AppIcon :icon="TONE_ICON[tone]" class="self-start pt-[3px]" :class="TONE_FG[tone]" />
    <div class="flex min-w-0 flex-1 gap-lg" :class="below ? 'flex-col items-start' : 'items-center'">
      <div class="min-w-0 flex-1" :class="toneText(tone)">
        <div v-if="title" class="text-sm font-medium leading-normal">{{ title }}</div>
        <div class="text-xs leading-[17px]" :class="title ? 'mt-xs' : ''"><slot /></div>
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-sm"><slot name="actions" /></div>
    </div>
  </div>
</template>
