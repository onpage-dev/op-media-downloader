<script setup lang="ts">
/** The speed of the last seconds as a line in the accent's -fg */
import { computed } from 'vue'

const props = withDefaults(defineProps<{ values: number[]; width?: number; height?: number }>(), { width: 48, height: 24 })
const points = computed(() => {
  const values = props.values.length > 1 ? props.values : [0, 0]
  const top = Math.max(...values) || 1
  return values
    .map((v, i) => `${((i * props.width) / (values.length - 1)).toFixed(1)},${(props.height - 2 - (v / top) * (props.height - 5)).toFixed(1)}`)
    .join(' ')
})
</script>

<template>
  <svg :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" class="shrink-0 text-accent-fg" aria-hidden="true">
    <polyline :points="points" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
  </svg>
</template>
