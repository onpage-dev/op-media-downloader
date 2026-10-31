<script setup lang="ts">
/**
 * The toolbar: tools that act on the selected project, an icon over a 12px
 * label, off when they do not apply; the search and the settings on the right.
 * Narrow, «Impostazioni» keeps its icon and gives its name to the tooltip.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import * as icons from '../lib/icons'
import { app, ask, can, download, edit, openFolder, openSettings, openWizard, sync, syncAll } from '../store'
import AppIcon from './ui/AppIcon.vue'
import IconButton from './ui/IconButton.vue'
import SearchField from './ui/SearchField.vue'

interface Tool {
  key: string
  icon: icons.IconDefinition
  keys?: string
  on: boolean
  action: () => void
}

const { t } = useI18n()
const mac = window.desktop.platform == 'darwin'
const mod = mac ? '⌘' : 'Ctrl+'
const tools = computed<(Tool | '|')[]>(() => [
  { key: 'new', icon: icons.faPlus, keys: `${mod}N`, on: true, action: () => openWizard() },
  '|',
  { key: 'sync', icon: icons.faArrowsRotate, keys: `${mod}R`, on: can.value.sync, action: () => sync() },
  { key: 'download', icon: icons.faArrowDownToBracket, on: can.value.download, action: () => download() },
  { key: 'stop', icon: icons.faStop, on: can.value.stop, action: () => ask('stop') },
  '|',
  { key: 'sync_all', icon: icons.faLayerGroup, keys: mac ? '⌘⇧R' : 'Ctrl+Maiusc+R', on: can.value.sync_all, action: syncAll },
  '|',
  { key: 'open', icon: icons.faFolderOpen, keys: `${mod}O`, on: can.value.selected, action: () => openFolder() },
  { key: 'edit', icon: icons.faPenToSquare, on: can.value.selected, action: () => edit() },
  { key: 'delete', icon: icons.faTrashCan, keys: mac ? '⌘⌫' : 'Canc', on: can.value.selected, action: () => ask('delete') },
])

const search = ref<InstanceType<typeof SearchField>>()
watch(
  () => app.search_focus,
  () => search.value?.focus(),
)
const narrow = ref(window.innerWidth < 1000)
const onResize = (): void => {
  narrow.value = window.innerWidth < 1000
}
window.addEventListener('resize', onResize)
onBeforeUnmount(() => window.removeEventListener('resize', onResize))
</script>

<template>
  <nav class="flex h-14 shrink-0 items-center gap-2xs px-sm" :aria-label="t('app.short')">
    <template v-for="(tool, n) in tools" :key="tool == '|' ? `line${n}` : tool.key">
      <span v-if="tool == '|'" class="h-9 w-px bg-line" />
      <button
        v-else
        v-tooltip="tool.keys ? `${t(`toolbar.${tool.key}`)} · ${tool.keys}` : t(`toolbar.${tool.key}`)"
        type="button"
        :disabled="!tool.on"
        class="flex flex-col items-center gap-xs rounded-md px-sm py-[6px] text-text enabled:hover:bg-text/[.06] disabled:text-disabled"
        @click="tool.action"
      >
        <AppIcon :icon="tool.icon" class="text-[17px]" />
        <span class="whitespace-nowrap text-xs font-medium">{{ t(`toolbar.${tool.key}`) }}</span>
      </button>
    </template>
    <span class="flex-1" />
    <SearchField
      ref="search"
      v-model="app.query"
      :placeholder="t('toolbar.search')"
      :clear-label="t('common.close')"
      :class="narrow ? 'w-[140px]' : 'w-[200px]'"
    />
    <IconButton v-if="narrow" :icon="icons.faGear" :label="`${t('toolbar.settings')} · ${mod},`" :size="36" class="ml-xs" @click="openSettings()" />
    <button
      v-else
      v-tooltip="`${t('toolbar.settings')} · ${mod},`"
      type="button"
      class="ml-xs flex flex-col items-center gap-xs rounded-md px-sm py-[6px] hover:bg-text/[.06]"
      @click="openSettings()"
    >
      <AppIcon :icon="icons.faGear" class="text-[17px]" />
      <span class="text-xs font-medium">{{ t('toolbar.settings') }}</span>
    </button>
  </nav>
</template>
