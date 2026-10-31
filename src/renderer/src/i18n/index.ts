import { createI18n } from 'vue-i18n'
import { type AppLanguage, LANGUAGES } from '@shared/models'
import de from './de.json'
import en from './en.json'
import es from './es.json'
import fr from './fr.json'
import it from './it.json'
import { pluralRule } from './plural'
import ru from './ru.json'
import sv from './sv.json'
import zh from './zh.json'

export type MessageSchema = typeof it

export const i18n = createI18n<[MessageSchema], AppLanguage, false>({
  legacy: false,
  locale: 'it',
  fallbackLocale: 'en',
  messages: { it, en, de, es, fr, ru, sv, zh },
  pluralRules: Object.fromEntries(LANGUAGES.map(language => [language, pluralRule(language)])),
})

/** The page's `lang`, which picks the glyphs: the Chinese of On Page is simplified */
const PAGE_LANG: Partial<Record<AppLanguage, string>> = { zh: 'zh-CN' }

export function setLanguage(language: AppLanguage): void {
  i18n.global.locale.value = language
  document.documentElement.lang = PAGE_LANG[language] ?? language
}
