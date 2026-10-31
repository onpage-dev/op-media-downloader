/**
 * `v-tooltip="text"`: the dark bubble under an element after a short hover,
 * light in dark mode; the text is also the element's accessible name when it
 * has none (icon buttons).
 */
import type { Directive } from 'vue'

let bubble: HTMLDivElement | undefined
let timer: ReturnType<typeof setTimeout> | undefined
const texts = new WeakMap<HTMLElement, string>()

function hide(): void {
  clearTimeout(timer)
  bubble?.remove()
  bubble = undefined
}

function show(el: HTMLElement): void {
  const text = texts.get(el)
  if (!text || !el.isConnected) return
  hide()
  bubble = document.createElement('div')
  bubble.setAttribute('role', 'tooltip')
  bubble.className =
    'pointer-events-none fixed z-[100] max-w-[320px] rounded-sm bg-text px-sm py-[6px] text-xs text-box shadow-popover'
  bubble.textContent = text
  document.body.append(bubble)
  const anchor = el.getBoundingClientRect()
  const own = bubble.getBoundingClientRect()
  const below = anchor.bottom + 6 + own.height < window.innerHeight
  const left = Math.min(Math.max(4, anchor.left + anchor.width / 2 - own.width / 2), window.innerWidth - own.width - 4)
  bubble.style.left = `${left}px`
  bubble.style.top = `${below ? anchor.bottom + 6 : anchor.top - own.height - 6}px`
}

function enter(this: HTMLElement): void {
  clearTimeout(timer)
  timer = setTimeout(() => show(this), 500)
}

function set(el: HTMLElement, text: string | undefined): void {
  texts.set(el, text ?? '')
  if (text && !el.getAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', text)
}

export const vTooltip: Directive<HTMLElement, string | undefined> = {
  mounted(el, binding) {
    set(el, binding.value)
    el.addEventListener('mouseenter', enter)
    el.addEventListener('mouseleave', hide)
    el.addEventListener('mousedown', hide)
  },
  updated(el, binding) {
    set(el, binding.value)
  },
  unmounted(el) {
    if (bubble) hide()
    el.removeEventListener('mouseenter', enter)
    el.removeEventListener('mouseleave', hide)
    el.removeEventListener('mousedown', hide)
  },
}
