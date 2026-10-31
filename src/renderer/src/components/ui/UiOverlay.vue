<script lang="ts">
/** The overlays open now, the last one on top: only that one is not inert */
const open: HTMLElement[] = []

function arrange(): void {
  document.getElementById('app')?.toggleAttribute('inert', open.length > 0)
  open.forEach((overlay, n) => overlay.toggleAttribute('inert', n < open.length - 1))
}

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]'
const tabbables = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(el => el.tabIndex >= 0 && el.getClientRects().length > 0)
</script>

<script setup lang="ts">
/**
 * What every modal shares (the wizard, the questions, the settings over the
 * window): the veil, the card as a dialog named by its title, the focus moved
 * into it (on `[data-autofocus]`, else the first control) and kept there (Tab
 * and Maiusc+Tab go round), Esc and a press on the veil to close it, the focus
 * back where it was once it closes. The window under it is inert meanwhile; the
 * toasts stay usable.
 */
import { onBeforeUnmount, onMounted, ref, useId } from 'vue'

defineOptions({ inheritAttrs: false })
withDefaults(defineProps<{ role?: 'dialog' | 'alertdialog'; described?: boolean }>(), { role: 'dialog' })
const emit = defineEmits<{ close: [] }>()
defineSlots<{ default(props: { titleId: string; textId: string }): unknown }>()

const id = useId()
const titleId = `${id}-title`
const textId = `${id}-text`
const veil = ref<HTMLElement>()
const panel = ref<HTMLElement>()
let previous: HTMLElement | null = null

function onKey(event: KeyboardEvent): void {
  if (event.key == 'Escape' && !event.isComposing) {
    event.preventDefault()
    event.stopPropagation()
    return emit('close')
  }
  if (event.key != 'Tab' || !panel.value) return
  const items = tabbables(panel.value)
  const [first, last] = [items[0], items[items.length - 1]]
  const active = document.activeElement
  if (!first) return event.preventDefault()
  if (event.shiftKey && (active == first || active == panel.value)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active == last) {
    event.preventDefault()
    first.focus()
  }
}

/** The focus that gets out (a click on the veil's edge, a toast is fine) comes back to the card */
function guard(event: FocusEvent): void {
  const target = event.target as HTMLElement | null
  if (open[open.length - 1] != veil.value || !panel.value || !target) return
  if (panel.value.contains(target) || target.closest('[data-toasts]')) return
  ;(tabbables(panel.value)[0] ?? panel.value).focus()
}

onMounted(() => {
  previous = document.activeElement as HTMLElement | null
  if (veil.value) open.push(veil.value)
  arrange()
  const card = panel.value
  if (card) (card.querySelector<HTMLElement>('[data-autofocus]') ?? tabbables(card)[0] ?? card).focus()
  document.addEventListener('focusin', guard)
})
// Before the card goes: the focus goes back while this overlay is still the top one, so that one
// opening in the same moment (a question after a menu) takes the focus from there
onBeforeUnmount(() => {
  document.removeEventListener('focusin', guard)
  const at = veil.value ? open.indexOf(veil.value) : -1
  if (at >= 0) open.splice(at, 1)
  arrange()
  if (previous?.isConnected) previous.focus({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body">
    <div ref="veil" class="fixed inset-0 z-50 flex items-center justify-center bg-veil p-lg" @mousedown.self="emit('close')">
      <div
        ref="panel"
        :role="role"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="described ? textId : undefined"
        tabindex="-1"
        v-bind="$attrs"
        @keydown="onKey"
      >
        <slot :title-id="titleId" :text-id="textId" />
      </div>
    </div>
  </Teleport>
</template>
