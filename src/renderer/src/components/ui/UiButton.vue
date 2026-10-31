<script setup lang="ts">
/**
 * The buttons of the design system: one primary per area, secondary beside it,
 * ghost for the minor ones, warning to stop, critical to delete. 39px, or 32px
 * where the app is dense; loading spins and keeps the label's room.
 */
import { computed } from 'vue'
import type { IconDefinition } from '../../lib/icons'
import AppIcon from './AppIcon.vue'
import UiSpinner from './UiSpinner.vue'

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'warning' | 'critical' | 'link'
    icon?: IconDefinition
    size?: 'md' | 'sm'
    loading?: boolean
    disabled?: boolean
    type?: 'button' | 'submit'
  }>(),
  { variant: 'secondary', size: 'md', type: 'button' },
)

const LOOK = {
  primary: 'bg-accent text-accent-inv enabled:hover:bg-accent-hover disabled:bg-accent-off',
  secondary: 'border border-line bg-box text-text enabled:hover:bg-text/[.06] disabled:text-disabled',
  ghost: 'text-text enabled:hover:bg-text/[.06] disabled:text-disabled',
  warning: 'bg-warning text-warning-inv enabled:hover:brightness-95 disabled:opacity-50',
  critical: 'bg-danger text-danger-inv enabled:hover:brightness-95 disabled:opacity-50',
  link: 'text-accent-fg enabled:hover:bg-accent-soft disabled:text-disabled',
} as const
const classes = computed(() => [LOOK[props.variant], props.size == 'md' ? 'h-[39px] px-md' : 'h-8 px-sm'])
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    class="relative inline-flex shrink-0 items-center justify-center gap-sm whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-100"
    :class="classes"
  >
    <span class="inline-flex items-center gap-sm" :class="{ invisible: loading }">
      <AppIcon v-if="icon" :icon="icon" />
      <slot />
    </span>
    <UiSpinner v-if="loading" class="absolute" />
  </button>
</template>
