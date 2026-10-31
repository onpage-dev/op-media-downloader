<script setup lang="ts">
/** OpLangSelect: the flag, the language and the chevron; the languages in a menu under it */
import { onBeforeUnmount, ref } from 'vue'
import cn from 'flag-icons/flags/4x3/cn.svg'
import de from 'flag-icons/flags/4x3/de.svg'
import es from 'flag-icons/flags/4x3/es.svg'
import fr from 'flag-icons/flags/4x3/fr.svg'
import gb from 'flag-icons/flags/4x3/gb.svg'
import it from 'flag-icons/flags/4x3/it.svg'
import ru from 'flag-icons/flags/4x3/ru.svg'
import se from 'flag-icons/flags/4x3/se.svg'
import { type AppLanguage, LANGUAGES } from '@shared/models'
import { faCheck, faChevronDown } from '../../lib/icons'
import AppIcon from './AppIcon.vue'

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
const open = ref(false)
const root = ref<HTMLElement>()

const close = (event: MouseEvent): void => {
  if (!root.value?.contains(event.target as Node)) open.value = false
}
window.addEventListener('mousedown', close)
onBeforeUnmount(() => window.removeEventListener('mousedown', close))
const choose = (language: AppLanguage): void => {
  model.value = language
  open.value = false
}
</script>

<template>
  <div ref="root" class="relative w-[180px]">
    <button
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open"
      class="flex h-[39px] w-full items-center gap-sm rounded-md border bg-box px-md text-sm"
      :class="open ? 'border-accent-fg' : 'border-line hover:border-accent-fg'"
      @click="open = !open"
    >
      <img :src="FLAGS[model]" class="h-[17px] w-6 rounded-[2px] object-cover" alt="" />
      <span class="flex-1 text-left">{{ NAMES[model] }}</span>
      <AppIcon :icon="faChevronDown" />
    </button>
    <ul v-if="open" role="listbox" class="absolute left-0 right-0 top-[43px] z-20 rounded-xl border border-line bg-box p-xs shadow-popover">
      <li
        v-for="language in LANGUAGES"
        :key="language"
        role="option"
        :aria-selected="language == model"
        class="flex items-center gap-sm rounded-md px-[10px] py-[9px] text-sm"
        :class="language == model ? 'bg-accent-soft text-accent-fg' : 'hover:bg-text/[.06]'"
        @click="choose(language)"
      >
        <img :src="FLAGS[language]" class="h-[17px] w-6 rounded-[2px] object-cover" alt="" />
        <span class="flex-1">{{ NAMES[language] }}</span>
        <AppIcon v-if="language == model" :icon="faCheck" />
      </li>
    </ul>
  </div>
</template>
