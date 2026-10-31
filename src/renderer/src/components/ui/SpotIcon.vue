<script setup lang="ts">
/** The mark of a dialog (OpSpotIcon m): the icon in the colour's -fg over a soft cloud at its bottom left */
import type { IconDefinition } from '../../lib/icons'
import AppIcon from './AppIcon.vue'

defineProps<{ icon: IconDefinition; tone: 'accent' | 'warning' | 'danger' }>()
const SOFT = { accent: 'bg-accent-soft', warning: 'bg-warning-soft', danger: 'bg-danger-soft' } as const
const FG = { accent: 'text-accent-fg', warning: 'text-warning-fg', danger: 'text-danger-fg' } as const
</script>

<template>
  <span class="relative block h-8 w-8 shrink-0" aria-hidden="true">
    <span class="absolute bottom-0 left-0 h-[17px] w-8 rounded-full" :class="SOFT[tone]" />
    <span class="absolute bottom-[6px] left-[6px] h-[14px] w-[14px] rounded-full" :class="SOFT[tone]" />
    <AppIcon :icon="icon" class="absolute right-0 top-0 text-[23px]" :class="FG[tone]" />
  </span>
</template>
