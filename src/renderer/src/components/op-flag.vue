<template>
  <span
    :class="`fi fi-${iso} fis ${rounded ? 'rounded-full' : ''}`"
    :style="`width: ${size}em; height: ${size}em;`"
    class="shrink-0"
  />
</template>

<script lang="ts" setup>
import 'flag-icons/css/flag-icons.min.css'

defineProps({
  iso: {
    type: String,
  },
  size: {
    type: String,
    default: '1',
  },
  rounded: {
    type: Boolean,
  },
})
</script>
