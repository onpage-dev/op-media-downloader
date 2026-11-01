<script setup lang="ts">
/** The app's icon, the dark tile when the window is dark (the system's theme or the one chosen in the settings) */
import dark from '../../../assets/app-icon-dark.png'
import light from '../../../assets/app-icon.png'
</script>

<template>
  <picture class="shrink-0">
    <source :srcset="dark" media="(prefers-color-scheme: dark)" />
    <img :src="light" class="h-full w-full" alt="" />
  </picture>
</template>
