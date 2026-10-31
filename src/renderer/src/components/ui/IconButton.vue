<script setup lang="ts">
/** A square ghost button with its icon; its name is in the tooltip */
import type { IconDefinition } from '../../lib/icons'
import AppIcon from './AppIcon.vue'

withDefaults(defineProps<{ icon: IconDefinition; label: string; size?: number; disabled?: boolean }>(), { size: 28 })
</script>

<template>
  <button
    v-tooltip="label"
    type="button"
    :disabled="disabled"
    class="inline-flex shrink-0 items-center justify-center rounded-md text-text transition-colors duration-100 enabled:hover:bg-text/[.06] disabled:text-disabled"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <AppIcon :icon="icon" />
  </button>
</template>
