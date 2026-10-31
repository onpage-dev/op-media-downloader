<script setup lang="ts">
/**
 * OpAlert: a condition of the section it sits in, on the tone's soft with its
 * icon; the title 14 medium, the text 12; danger and warning write in their
 * -fg. The actions on the right, or under the words.
 */
import { computed } from 'vue'
import { faCircleCheck, faCircleExclamation, faCircleInfo, faTriangleExclamation } from '../../lib/icons'
import AppIcon from './AppIcon.vue'

const props = withDefaults(
  defineProps<{ tone: 'success' | 'info' | 'warning' | 'danger' | 'neutral'; title?: string; below?: boolean }>(),
  { below: false },
)
const LOOK = {
  success: ['bg-success-soft', 'text-success-fg', '', faCircleCheck],
  info: ['bg-info-soft', 'text-info-fg', '', faCircleInfo],
  warning: ['bg-warning-soft', 'text-warning-fg', 'text-warning-fg', faTriangleExclamation],
  danger: ['bg-danger-soft', 'text-danger-fg', 'text-danger-fg', faCircleExclamation],
  neutral: ['bg-neutral-soft', 'text-neutral-fg', '', faCircleInfo],
} as const
const look = computed(() => LOOK[props.tone])
</script>

<template>
  <div class="flex gap-sm rounded-xl p-lg" :class="[look[0], below ? 'items-start' : 'items-center']" role="status">
    <AppIcon :icon="look[3]" class="self-start pt-[3px]" :class="look[1]" />
    <div class="flex min-w-0 flex-1 gap-lg" :class="below ? 'flex-col items-start' : 'items-center'">
      <div class="min-w-0 flex-1" :class="look[2]">
        <div v-if="title" class="text-sm font-medium leading-[21px]">{{ title }}</div>
        <div class="text-xs leading-[17px]" :class="title ? 'mt-xs' : ''"><slot /></div>
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-sm"><slot name="actions" /></div>
    </div>
  </div>
</template>
