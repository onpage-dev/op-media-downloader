<script setup lang="ts">
/** `#/tray`: the panel of the notification area, alone in its frameless window */
import { onMounted } from 'vue'
import TrayPanel from './components/TrayPanel.vue'
import { init } from './store'

onMounted(() => void init({ live: false }))
</script>

<template>
  <TrayPanel />
</template>
