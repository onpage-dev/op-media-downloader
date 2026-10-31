<script setup lang="ts">
/** The menu of a row (OpActionsCard) where the pointer is: the actions on that project, «Elimina…» last and red */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import * as icons from '../lib/icons'
import { app, ask, can, copyPath, download, edit, openFolder, sync } from '../store'
import AppIcon from './ui/AppIcon.vue'

const { t } = useI18n()
const card = ref<HTMLElement>()
const at = ref({ x: 0, y: 0 })
const project = computed(() => app.projects.find(p => p.id == app.menu?.id))

const items = computed(() => {
  const p = project.value
  if (!p) return []
  const running = p.runtime.phase != 'idle'
  return [
    { key: 'sync_now', icon: icons.faArrowsRotate, on: can.value.sync, run: () => sync(p.id) },
    running
      ? { key: 'stop', icon: icons.faStop, on: can.value.stop, run: () => ask('stop', p.id) }
      : { key: 'download', icon: icons.faArrowDownToBracket, on: can.value.download, run: () => download(p.id) },
    '-',
    { key: 'open', icon: icons.faFolderOpen, on: true, run: () => openFolder(p.id) },
    { key: 'copy_path', icon: icons.faCopy, on: true, run: () => copyPath(p.id) },
    '-',
    { key: 'edit', icon: icons.faPenToSquare, on: true, run: () => edit(p.id) },
    { key: 'delete', icon: icons.faTrashCan, on: true, danger: true, run: () => ask('delete', p.id) },
  ] as const
})

const close = (): void => {
  app.menu = undefined
}
const outside = (event: MouseEvent): void => {
  if (!card.value?.contains(event.target as Node)) close()
}
const onKey = (event: KeyboardEvent): void => {
  if (event.key == 'Escape') close()
}
watch(
  () => app.menu,
  async menu => {
    if (!menu) return
    at.value = { x: menu.x, y: menu.y }
    await nextTick()
    const box = card.value?.getBoundingClientRect()
    if (!box) return
    at.value = {
      x: Math.min(menu.x, window.innerWidth - box.width - 4),
      y: menu.y + box.height > window.innerHeight ? Math.max(4, menu.y - box.height) : menu.y,
    }
  },
  { immediate: true },
)
window.addEventListener('mousedown', outside, true)
window.addEventListener('keydown', onKey)
window.addEventListener('blur', close)
onBeforeUnmount(() => {
  window.removeEventListener('mousedown', outside, true)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('blur', close)
})
function choose(run: () => void): void {
  close()
  run()
}
</script>

<template>
  <div
    v-if="project"
    ref="card"
    role="menu"
    class="fixed z-40 w-[220px] rounded-xl border border-line bg-box p-xs shadow-popover"
    :style="{ left: `${at.x}px`, top: `${at.y}px` }"
  >
    <template v-for="(item, n) in items" :key="item == '-' ? `line${n}` : item.key">
      <div v-if="item == '-'" class="mx-[6px] my-xs h-px bg-line" />
      <button
        v-else
        type="button"
        role="menuitem"
        :disabled="!item.on"
        class="flex w-full items-center gap-sm rounded-md py-[9px] pl-sm pr-[10px] text-left text-sm enabled:hover:bg-text/[.06] disabled:text-disabled"
        :class="'danger' in item ? 'text-danger-fg' : ''"
        @click="choose(item.run)"
      >
        <span class="flex h-5 w-5 items-center justify-center"><AppIcon :icon="item.icon" /></span>
        {{ t(`menu.${item.key}`) }}
      </button>
    </template>
  </div>
</template>
