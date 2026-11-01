<script setup lang="ts">
/**
 * OpProgressBar: a pill, the track in the tone's soft (or the line's colour
 * on a row that is already soft) and the fill in the tone's -fg, the
 * percentage in text-xs beside it (`label` says something else, `bare`
 * nothing). `name` is what it measures, for screen readers.
 */
import { computed } from 'vue'
import { formatPercent } from '../../lib/format'

const props = withDefaults(
  defineProps<{
    value: number
    name: string
    tone?: 'accent' | 'warning'
    size?: 'xs' | 's' | 'm'
    label?: string
    bare?: boolean
    lined?: boolean
  }>(),
  { tone: 'accent', size: 's' },
)
const percent = computed(() => Math.floor(Math.min(1, Math.max(0, props.value)) * 100))
const text = computed(() => props.label ?? formatPercent(props.value))
</script>

<template>
  <div
    class="flex min-w-0 items-center gap-sm"
    role="progressbar"
    :aria-label="name"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-valuenow="percent"
    :aria-valuetext="text"
  >
    <div
      class="min-w-0 flex-1 overflow-hidden rounded-full"
      :class="[
        { xs: 'h-[2px]', s: 'h-1', m: 'h-2' }[size],
        lined ? 'bg-line' : tone == 'accent' ? 'bg-accent-soft' : 'bg-warning-soft',
      ]"
    >
      <div
        class="h-full rounded-full transition-[width] duration-300"
        :class="tone == 'accent' ? 'bg-accent-fg' : 'bg-warning-fg'"
        :style="{ width: `${Math.max(percent, 2)}%` }"
      />
    </div>
    <span v-if="!bare" class="tabular shrink-0 text-xs" aria-hidden="true">{{ text }}</span>
  </div>
</template>
