<script setup lang="ts">
/** Why a form could not do what was asked, in place: 12px in the danger's -fg, read at once by screen readers */
defineProps<{ text?: string }>()
</script>

<template>
  <p v-if="text" role="alert" class="text-xs text-danger-fg">{{ text }}</p>
</template>
