import { createI18n } from 'vue-i18n'
import type { AppLanguage } from '@shared/models'
import en from './en.json'
import it from './it.json'

export type MessageSchema = typeof it

export const i18n = createI18n<[MessageSchema], AppLanguage, false>({
  legacy: false,
  locale: 'it',
  fallbackLocale: 'it',
  messages: { it, en },
})

export function setLanguage(language: AppLanguage): void {
  i18n.global.locale.value = language
  document.documentElement.lang = language
}
