<script setup lang="ts">
/**
 * The toolbar: tools that act on the selected project, an icon over a 12px
 * label, off when they do not apply; the search and the settings on the right.
 * When the labels leave the search less than 160px (a narrow window, a long
 * language), every tool keeps its icon and gives its name to the tooltip.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import * as icons from '../lib/icons'
import { app, ask, can, download, edit, openFolder, openSettings, openWizard, platform, sync, syncAll } from '../store'
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

const { t, locale } = useI18n()
const mac = platform() == 'darwin'
/** Key names as the keyboard of the language prints them (Strg, Maj, Entf…) */
const mod = computed(() => (mac ? '⌘' : `${t('keys.ctrl')}+`))
const tools = computed<(Tool | '|')[]>(() => [
  { key: 'new', icon: icons.faPlus, keys: `${mod.value}N`, on: true, action: () => openWizard() },
  '|',
  { key: 'sync', icon: icons.faArrowsRotate, keys: `${mod.value}R`, on: can.value.sync, action: () => sync() },
  { key: 'download', icon: icons.faArrowDownToBracket, on: can.value.download, action: () => download() },
  { key: 'stop', icon: icons.faStop, on: can.value.stop, action: () => ask('stop') },
  '|',
  {
    key: 'sync_all',
    icon: icons.faLayerGroup,
    keys: mac ? '⌘⇧R' : `${t('keys.ctrl')}+${t('keys.shift')}+R`,
    on: can.value.sync_all,
    action: syncAll,
  },
  '|',
  { key: 'open', icon: icons.faFolderOpen, keys: `${mod.value}O`, on: can.value.selected, action: () => openFolder() },
  { key: 'edit', icon: icons.faPenToSquare, on: can.value.selected, action: () => edit() },
  {
    key: 'delete',
    icon: icons.faTrashCan,
    keys: mac ? '⌘⌫' : t('keys.delete'),
    on: can.value.selected,
    action: () => ask('delete'),
  },
])

const search = ref<InstanceType<typeof SearchField>>()
watch(
  () => app.search_focus,
  () => search.value?.focus(),
)
const SEARCH_MIN = 160
const nav = ref<HTMLElement>()
const compact = ref(false)
/** The toolbar width the labels need, measured the last time they were shown */
let needed = 0
const measure = (): void => {
  const bar = nav.value
  const field = search.value?.$el as HTMLElement | undefined
  if (!bar || !field) return
  if (!compact.value) {
    const room = field.getBoundingClientRect().width
    needed = bar.clientWidth - room + SEARCH_MIN
    if (room < SEARCH_MIN) compact.value = true
  } else if (bar.clientWidth >= needed + 8) {
    compact.value = false
  }
}
const observer = new ResizeObserver(measure)
watch(nav, (now, before) => {
  if (before) observer.unobserve(before)
  if (now) observer.observe(now)
})
// Another language, other labels: measure them again
watch(locale, async () => {
  compact.value = false
  await nextTick()
  measure()
})
onBeforeUnmount(() => observer.disconnect())
</script>

<template>
  <nav ref="nav" class="flex h-14 shrink-0 items-center gap-2xs px-sm" :aria-label="t('app.short')">
    <template v-for="(tool, n) in tools" :key="tool == '|' ? `line${n}` : tool.key">
      <span v-if="tool == '|'" class="h-9 w-px bg-line" />
      <button
        v-else
        v-tooltip="tool.keys ? `${t(`toolbar.${tool.key}`)} · ${tool.keys}` : t(`toolbar.${tool.key}`)"
        type="button"
        :disabled="!tool.on"
        :aria-label="t(`toolbar.${tool.key}`)"
        class="flex flex-col items-center gap-xs rounded-md px-sm py-xs-sm text-text enabled:hover:bg-tint disabled:text-disabled"
        @click="tool.action"
      >
        <AppIcon :icon="tool.icon" class="text-lg" />
        <span v-if="!compact" class="whitespace-nowrap text-xs font-medium">{{ t(`toolbar.${tool.key}`) }}</span>
      </button>
    </template>
    <span class="flex-1" />
    <SearchField
      ref="search"
      v-model="app.query"
      :placeholder="t('toolbar.search')"
      :clear-label="t('common.close')"
      class="w-[200px]"
    />
    <IconButton
      v-if="compact"
      :icon="icons.faGear"
      :label="`${t('toolbar.settings')} · ${mod},`"
      :size="36"
      class="ml-xs"
      @click="openSettings()"
    />
    <button
      v-else
      v-tooltip="`${t('toolbar.settings')} · ${mod},`"
      type="button"
      class="ml-xs flex flex-col items-center gap-xs rounded-md px-sm py-xs-sm hover:bg-tint"
      @click="openSettings()"
    >
      <AppIcon :icon="icons.faGear" class="text-lg" />
      <span class="text-xs font-medium">{{ t('toolbar.settings') }}</span>
    </button>
  </nav>
</template>
