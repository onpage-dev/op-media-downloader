<script setup lang="ts">
/** `#/settings/<section>`: the settings alone, when main opens them in a window of their own */
import { onMounted, ref } from 'vue'
import type { SettingsSection } from '@shared/desktop-api'
import SettingsPanel from './components/SettingsPanel.vue'
import ToastStack from './components/ToastStack.vue'
import { closeWindow, init } from './store'

const SECTIONS: SettingsSection[] = ['general', 'download', 'appearance', 'language', 'updates', 'agents']
const asked = location.hash.split('/')[2] as SettingsSection | undefined
const section = ref<SettingsSection>(asked && SECTIONS.includes(asked) ? asked : 'general')
onMounted(() => void init({ live: false }))
</script>

<template>
  <SettingsPanel alone :section="section" @section="section = $event" @close="closeWindow" />
  <ToastStack />
</template>
