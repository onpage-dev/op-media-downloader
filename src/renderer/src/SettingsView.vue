<script setup lang="ts">
/** `#/settings/<section>`: the settings alone, when main opens them in a window of their own */
import { onMounted, ref } from 'vue'
import type { SettingsSection } from '@shared/desktop-api'
import SettingsPanel from './components/SettingsPanel.vue'
import { init } from './store'

const SECTIONS: SettingsSection[] = ['general', 'download', 'appearance', 'language', 'updates']
const asked = location.hash.split('/')[2] as SettingsSection | undefined
const section = ref<SettingsSection>(asked && SECTIONS.includes(asked) ? asked : 'general')
onMounted(() => void init({ live: false }))
const close = (): void => window.desktop.app.window.close()
</script>

<template>
  <SettingsPanel alone :section="section" @section="section = $event" @close="close" />
</template>
