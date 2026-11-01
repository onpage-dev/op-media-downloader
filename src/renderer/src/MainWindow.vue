<script setup lang="ts">
/**
 * The main window: title row, toolbar, filters, the table of jobs with the
 * inspector under it, the status bar; the dialogs and the toasts over them.
 * Here live the shortcuts (Ctrl/Cmd+N, R, Maiusc+R, virgola, O, F, Canc) and
 * the folders dropped on the window; the arrows belong to the table.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppToolbar from './components/AppToolbar.vue'
import ContextMenu from './components/ContextMenu.vue'
import EmptyTable from './components/EmptyTable.vue'
import FilterPanel from './components/FilterPanel.vue'
import InspectorPanel from './components/InspectorPanel.vue'
import JobsTable from './components/JobsTable.vue'
import NewProjectWizard from './components/NewProjectWizard.vue'
import ProjectDialogs from './components/ProjectDialogs.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import StatusBar from './components/StatusBar.vue'
import TitleBar from './components/TitleBar.vue'
import ToastStack from './components/ToastStack.vue'
import AppIcon from './components/ui/AppIcon.vue'
import UiOverlay from './components/ui/UiOverlay.vue'
import * as icons from './lib/icons'
import {
  app,
  ask,
  closeSettings,
  init,
  openDroppedFolder,
  openFolder,
  openSettings,
  openWizard,
  platform,
  selected,
  sync,
  syncAll,
} from './store'

const { t } = useI18n()
const mac = platform() == 'darwin'
const overlay = computed(() => !!(app.wizard || app.dialog || app.settings_open))

/** The inspector's height once the user drags it; until then the table takes its rows (up to 300px) and the inspector the rest */
const HEIGHT_KEY = 'inspector-height'
function storedHeight(): number | undefined {
  try {
    return Number(localStorage.getItem(HEIGHT_KEY)) || undefined
  } catch {
    return undefined
  }
}
const inspectorHeight = ref(storedHeight())
function rememberHeight(): void {
  try {
    if (inspectorHeight.value) localStorage.setItem(HEIGHT_KEY, String(inspectorHeight.value))
  } catch {
    // the height simply is not remembered
  }
}

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName == 'INPUT' || el.tagName == 'TEXTAREA' || el.tagName == 'SELECT' || el.isContentEditable)
}
/**
 * The key of a shortcut: the letter the layout writes when it is Latin, else
 * the key's place (with a Cyrillic layout Ctrl+R is still the R key)
 */
function shortcutKey(event: KeyboardEvent): string {
  const key = event.key.toLowerCase()
  if (/^[a-z,]$/.test(key)) return key
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase()
  return event.code == 'Comma' ? ',' : key
}
const SHORTCUTS: Record<string, (shift: boolean) => void> = {
  n: () => openWizard(),
  r: shift => (shift ? syncAll() : sync()),
  ',': () => openSettings(),
  o: () => openFolder(),
  f: () => app.search_focus++,
}
function onKey(event: KeyboardEvent): void {
  if (overlay.value || event.defaultPrevented) return
  const mod = mac ? event.metaKey : event.ctrlKey
  // In a field Canc and Cmd+Backspace edit the words: never a project's deletion
  const destructive = (!mod && event.key == 'Delete') || (mac && mod && event.key == 'Backspace')
  if (destructive) {
    if (typing(event.target) || event.altKey || event.shiftKey || !app.selectedId) return
    event.preventDefault()
    return ask('delete')
  }
  if (!mod || event.altKey) return
  const action = SHORTCUTS[shortcutKey(event)]
  if (!action) return
  event.preventDefault()
  action(event.shiftKey)
}

/** A folder dragged over the window: the veil, then the new project with it */
const hasFiles = (event: DragEvent): boolean => !!event.dataTransfer?.types.includes('Files')
function onDragOver(event: DragEvent): void {
  if (!hasFiles(event) || overlay.value) return
  event.preventDefault()
  app.dropping = true
}
function onDragLeave(event: DragEvent): void {
  if (!event.relatedTarget) app.dropping = false
}
function onDrop(event: DragEvent): void {
  if (!hasFiles(event)) return
  event.preventDefault()
  app.dropping = false
  const file = event.dataTransfer?.files[0]
  if (file) openDroppedFolder(file)
}

onMounted(() => {
  void init()
  window.addEventListener('keydown', onKey)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
})
</script>

<template>
  <div class="flex h-full flex-col">
    <TitleBar />
    <AppToolbar />
    <div class="flex min-h-0 flex-1">
      <FilterPanel />
      <main
        class="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-md border-l border-t border-line bg-box"
      >
        <EmptyTable v-if="app.ready && !app.projects.length" :over="app.dropping" />
        <template v-else>
          <JobsTable :class="selected && !inspectorHeight ? 'max-h-[300px] flex-none' : 'min-h-[120px] flex-1'" />
          <InspectorPanel
            v-if="selected"
            v-model:height="inspectorHeight"
            :project="selected"
            @resized="rememberHeight"
          />
        </template>
        <div
          v-if="app.dropping && app.projects.length"
          class="pointer-events-none absolute inset-0 flex items-center justify-center bg-accent-soft/95"
        >
          <div
            class="flex flex-col items-center gap-md rounded-xl border-[1.5px] border-dashed border-accent-fg bg-box px-[64px] py-3xl"
          >
            <AppIcon :icon="icons.faFolderOpen" class="text-[27px] text-accent-fg" />
            <p class="text-lg font-medium text-accent-fg">{{ t('empty.drop_on_table') }}</p>
            <p class="text-xs text-secondary">{{ t('empty.drop_text') }}</p>
          </div>
        </div>
      </main>
    </div>
    <StatusBar />
    <ContextMenu v-if="app.menu" />
    <NewProjectWizard v-if="app.wizard" v-bind="app.wizard" />
    <ProjectDialogs />
    <UiOverlay v-if="app.settings_open" v-slot="{ titleId }" class="max-w-full" @close="closeSettings">
      <SettingsPanel :section="app.settings_open" :title-id="titleId" @close="closeSettings" @section="openSettings" />
    </UiOverlay>
    <ToastStack />
  </div>
</template>
