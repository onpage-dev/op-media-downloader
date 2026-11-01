<script setup lang="ts">
/**
 * OpLangSelect: the flag, the language and the chevron; the languages in a
 * list under it. A select-only combobox: ↓, ↑, Invio or Spazio open the list,
 * the arrows (Home, End) go through it, Invio picks, Esc closes the list (and
 * only the list, not the settings around it). Name it with `aria-labelledby`.
 */
import { ref, useId } from 'vue'
import cn from 'flag-icons/flags/4x3/cn.svg'
import de from 'flag-icons/flags/4x3/de.svg'
import es from 'flag-icons/flags/4x3/es.svg'
import fr from 'flag-icons/flags/4x3/fr.svg'
import gb from 'flag-icons/flags/4x3/gb.svg'
import it from 'flag-icons/flags/4x3/it.svg'
import ru from 'flag-icons/flags/4x3/ru.svg'
import se from 'flag-icons/flags/4x3/se.svg'
import { type AppLanguage, LANGUAGES } from '@shared/models'
import { useClickOutside } from '../../composables/useClickOutside'
import { faCheck, faChevronDown } from '../../lib/icons'
import AppIcon from './AppIcon.vue'

defineOptions({ inheritAttrs: false })
const model = defineModel<AppLanguage>({ required: true })
const FLAGS: Record<AppLanguage, string> = { it, en: gb, de, es, fr, ru, sv: se, zh: cn }
/** Each language in its own name, as language menus do */
const NAMES: Record<AppLanguage, string> = {
  it: 'Italiano',
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  ru: 'Русский',
  sv: 'Svenska',
  zh: '中文',
}
const id = useId()
const optionId = (language: AppLanguage): string => `${id}-${language}`
const open = ref(false)
/** The option the keyboard is on while the list is open */
const active = ref<AppLanguage>(model.value)
/** Moved with the keys: the option under them shows its ring */
const keyed = ref(false)
const root = ref<HTMLElement>()
const button = ref<HTMLButtonElement>()

useClickOutside(root, () => (open.value = false))
function show(): void {
  active.value = model.value
  open.value = true
}
/** The pointer moves the active option, without the keyboard's ring */
function point(language: AppLanguage): void {
  active.value = language
  keyed.value = false
}
function choose(language: AppLanguage): void {
  model.value = language
  open.value = false
  button.value?.focus()
}
function onKey(event: KeyboardEvent): void {
  const at = LANGUAGES.indexOf(active.value)
  const go = (to: number): void => {
    event.preventDefault()
    keyed.value = true
    if (!open.value) return show()
    active.value = LANGUAGES[Math.min(LANGUAGES.length - 1, Math.max(0, to))]
  }
  switch (event.key) {
    case 'ArrowDown':
      return go(at + 1)
    case 'ArrowUp':
      return go(at - 1)
    case 'Home':
      return open.value ? go(0) : undefined
    case 'End':
      return open.value ? go(LANGUAGES.length - 1) : undefined
    case 'Enter':
    case ' ':
      // The keyboard does not click: the list opens or the option is picked here
      event.preventDefault()
      keyed.value = true
      return open.value ? choose(active.value) : show()
    case 'Escape':
      if (!open.value) return
      event.preventDefault()
      event.stopPropagation()
      open.value = false
      return
    case 'Tab':
      open.value = false
  }
}
</script>

<template>
  <div ref="root" class="relative w-[180px]">
    <button
      ref="button"
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="`${id}-list`"
      :aria-activedescendant="open ? optionId(active) : undefined"
      v-bind="$attrs"
      class="flex h-control w-full items-center gap-sm rounded-md border bg-box px-md text-sm"
      :class="open ? 'border-accent-fg' : 'border-line hover:border-accent-fg'"
      @click="open ? (open = false) : show()"
      @keydown="onKey"
    >
      <img :src="FLAGS[model]" class="h-[17px] w-6 rounded-xs object-cover" alt="" />
      <span class="flex-1 text-left">{{ NAMES[model] }}</span>
      <AppIcon :icon="faChevronDown" />
    </button>
    <ul
      v-if="open"
      :id="`${id}-list`"
      role="listbox"
      class="absolute left-0 right-0 top-[43px] z-20 rounded-xl border border-line bg-box p-xs shadow-popover"
    >
      <li
        v-for="language in LANGUAGES"
        :id="optionId(language)"
        :key="language"
        role="option"
        :aria-selected="language == model"
        class="flex items-center gap-sm rounded-md px-sm-md py-[9px] text-sm"
        :class="[
          language == model ? 'bg-accent-soft text-accent-fg' : language == active ? 'bg-tint' : 'hover:bg-tint',
          keyed && language == active ? 'focus-ring-inset' : '',
        ]"
        @mousemove="point(language)"
        @click="choose(language)"
      >
        <img :src="FLAGS[language]" class="h-[17px] w-6 rounded-xs object-cover" alt="" />
        <span class="flex-1">{{ NAMES[language] }}</span>
        <AppIcon v-if="language == model" :icon="faCheck" />
      </li>
    </ul>
  </div>
</template>
