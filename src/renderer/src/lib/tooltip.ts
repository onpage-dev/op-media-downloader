/**
 * `v-tooltip="text"`: the dark bubble under an element after a short hover,
 * or at once when the keyboard brings the focus there; light in dark mode. Esc
 * hides it. The text is also the element's accessible name when it has none
 * (icon buttons), and that name follows the text (another language).
 */
import type { Directive } from 'vue'

let bubble: HTMLDivElement | undefined
let owner: HTMLElement | undefined
let timer: ReturnType<typeof setTimeout> | undefined
const texts = new WeakMap<HTMLElement, string>()
/** The elements whose name the tooltip gave */
const named = new WeakSet<HTMLElement>()

function hide(): void {
  clearTimeout(timer)
  bubble?.remove()
  bubble = owner = undefined
  window.removeEventListener('keydown', escape, true)
}

/** Esc hides the bubble, and only that: a second Esc closes the dialog under it */
function escape(event: KeyboardEvent): void {
  if (event.key != 'Escape' || !bubble) return
  event.stopPropagation()
  hide()
}

function show(el: HTMLElement): void {
  const text = texts.get(el)
  if (!text || !el.isConnected) return
  hide()
  bubble = document.createElement('div')
  bubble.setAttribute('role', 'tooltip')
  bubble.className =
    'pointer-events-none fixed z-[100] max-w-[320px] rounded-sm bg-text px-sm py-xs-sm text-xs text-box shadow-popover'
  bubble.textContent = text
  document.body.append(bubble)
  owner = el
  const anchor = el.getBoundingClientRect()
  const own = bubble.getBoundingClientRect()
  const below = anchor.bottom + 6 + own.height < window.innerHeight
  const left = Math.min(Math.max(4, anchor.left + anchor.width / 2 - own.width / 2), window.innerWidth - own.width - 4)
  bubble.style.left = `${left}px`
  bubble.style.top = `${below ? anchor.bottom + 6 : anchor.top - own.height - 6}px`
  window.addEventListener('keydown', escape, true)
}

function enter(this: HTMLElement): void {
  clearTimeout(timer)
  timer = setTimeout(() => show(this), 500)
}

/** The focus from the keyboard, not from a click */
function focus(this: HTMLElement): void {
  if (this.matches(':focus-visible')) show(this)
}

function set(el: HTMLElement, text: string | undefined): void {
  texts.set(el, text ?? '')
  if (named.has(el) || (!el.hasAttribute('aria-label') && !el.textContent?.trim())) {
    if (text) {
      el.setAttribute('aria-label', text)
      named.add(el)
    } else if (named.delete(el)) {
      el.removeAttribute('aria-label')
    }
  }
  if (owner == el && bubble) {
    if (text) bubble.textContent = text
    else hide()
  }
}

export const vTooltip: Directive<HTMLElement, string | undefined> = {
  mounted(el, binding) {
    set(el, binding.value)
    el.addEventListener('mouseenter', enter)
    el.addEventListener('mouseleave', hide)
    el.addEventListener('mousedown', hide)
    el.addEventListener('focus', focus)
    el.addEventListener('blur', hide)
  },
  updated(el, binding) {
    set(el, binding.value)
  },
  unmounted(el) {
    if (owner == el) hide()
    el.removeEventListener('mouseenter', enter)
    el.removeEventListener('mouseleave', hide)
    el.removeEventListener('mousedown', hide)
    el.removeEventListener('focus', focus)
    el.removeEventListener('blur', hide)
  },
}
