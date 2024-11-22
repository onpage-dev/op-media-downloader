<script lang="ts" setup>
import 'flag-icons/css/flag-icons.min.css'
withDefaults(
  defineProps<{
    iso?: string
    size?: string
    rounded?: boolean
  }>(),
  {
    size: '1',
  },
)
</script>
<template>
  <span
    :class="`fi fi-${iso} fis ${rounded ? 'rounded-full' : ''}`"
    :style="`width: ${size}em; height: ${size}em;`"
    class="shrink-0"
  />
</template>
