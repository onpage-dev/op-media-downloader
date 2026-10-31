<script setup lang="ts">
/** A wait that cannot be measured: an open arc on its circle, one turn a second, in the text's colour */
</script>

<template>
  <svg class="h-[1em] w-[1em] shrink-0 animate-spin" viewBox="0 0 20 20" role="status" aria-hidden="true">
    <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="2" />
    <path d="M10 2a8 8 0 1 1-7.6 10.47" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
  </svg>
</template>
