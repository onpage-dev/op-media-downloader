<script setup lang="ts">
/**
 * The menu of a row (OpActionsCard) where the pointer is: the actions on that
 * project, «Elimina…» last and red. A menu for the keyboard too: the focus on
 * its first action, ↑ ↓ (Home, End) through the actions that apply, Invio to
 * choose, Esc or Tab to close it and go back to the table.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClickOutside } from '../composables/useClickOutside'
import * as icons from '../lib/icons'
import { app, ask, can, copyPath, download, edit, openFolder, sync } from '../store'
import AppIcon from './ui/AppIcon.vue'

const { t } = useI18n()
const card = ref<HTMLElement>()
const at = ref({ x: app.menu?.x ?? 0, y: app.menu?.y ?? 0 })
const project = computed(() => app.projects.find(p => p.id == app.menu?.id))
/** Where the focus was: it goes back there when the menu closes */
const previous = document.activeElement as HTMLElement | null

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
useClickOutside(card, close)
/** The focus going elsewhere (a shortcut, the search) closes it too; a click on a line or an action that does not apply keeps it on the card */
function onFocusOut(event: FocusEvent): void {
  if (!card.value?.contains(event.relatedTarget as Node | null)) close()
}

const actions = (): HTMLElement[] => [
  ...(card.value?.querySelectorAll<HTMLElement>('[role=menuitem]:not(:disabled)') ?? []),
]
function onKey(event: KeyboardEvent): void {
  const list = actions()
  const now = list.indexOf(document.activeElement as HTMLElement)
  const to = (n: number): void => {
    event.preventDefault()
    list[(n + list.length) % list.length]?.focus()
  }
  switch (event.key) {
    case 'ArrowDown':
      return to(now + 1)
    case 'ArrowUp':
      return to(now < 0 ? -1 : now - 1)
    case 'Home':
      return to(0)
    case 'End':
      return to(-1)
    case 'Escape':
    case 'Tab':
      event.preventDefault()
      event.stopPropagation()
      return close()
  }
}

onMounted(async () => {
  await nextTick()
  const menu = app.menu
  const box = card.value?.getBoundingClientRect()
  if (menu && box) {
    at.value = {
      x: Math.min(menu.x, window.innerWidth - box.width - 4),
      y: menu.y + box.height > window.innerHeight ? Math.max(4, menu.y - box.height) : menu.y,
    }
  }
  actions()[0]?.focus()
})
window.addEventListener('blur', close)
// Before the menu goes, while its action still has the focus: a question it opens takes the focus from the table
onBeforeUnmount(() => {
  window.removeEventListener('blur', close)
  if (card.value?.contains(document.activeElement)) previous?.focus({ preventScroll: true })
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
    tabindex="-1"
    :aria-label="project.label"
    class="fixed z-40 w-[220px] rounded-xl border border-line bg-box p-xs shadow-popover"
    :style="{ left: `${at.x}px`, top: `${at.y}px` }"
    @keydown="onKey"
    @focusout="onFocusOut"
  >
    <template v-for="(item, n) in items" :key="item == '-' ? `line${n}` : item.key">
      <div v-if="item == '-'" role="separator" class="mx-xs-sm my-xs h-px bg-line" />
      <button
        v-else
        type="button"
        role="menuitem"
        tabindex="-1"
        :disabled="!item.on"
        class="flex w-full items-center gap-sm rounded-md py-[9px] pl-sm pr-sm-md text-left text-sm enabled:hover:bg-tint enabled:focus-visible:bg-tint disabled:text-disabled"
        :class="'danger' in item ? 'text-danger-fg' : ''"
        @click="choose(item.run)"
      >
        <span class="flex h-5 w-5 items-center justify-center"><AppIcon :icon="item.icon" /></span>
        {{ t(`menu.${item.key}`) }}
      </button>
    </template>
  </div>
</template>
