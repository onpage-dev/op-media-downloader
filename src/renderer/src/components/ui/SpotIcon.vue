<script setup lang="ts">
/** The mark of a dialog (OpSpotIcon m): the icon in the colour's -fg over a soft cloud at its bottom left */
import type { IconDefinition } from '../../lib/icons'
import { TONE_FG, TONE_SOFT } from '../../lib/status-view'
import AppIcon from './AppIcon.vue'

defineProps<{ icon: IconDefinition; tone: 'accent' | 'warning' | 'danger' }>()
</script>

<template>
  <span class="relative block h-8 w-8 shrink-0" aria-hidden="true">
    <span class="absolute bottom-0 left-0 h-[17px] w-8 rounded-full" :class="TONE_SOFT[tone]" />
    <span class="absolute bottom-xs-sm left-xs-sm h-[14px] w-[14px] rounded-full" :class="TONE_SOFT[tone]" />
    <AppIcon :icon="icon" class="absolute right-0 top-0 text-[23px]" :class="TONE_FG[tone]" />
  </span>
</template>
