/** Texts shown by main: notifications, tray menu, jump list, dialogs */
import { AppLanguage, LANGUAGES } from '../../shared/models'
import { de } from './de'
import { en } from './en'
import { es } from './es'
import { fr } from './fr'
import { it, Texts } from './it'
import { ru } from './ru'
import { sv } from './sv'
import { zh } from './zh'

const TEXTS: Record<AppLanguage, Texts> = { it, en, de, es, fr, ru, sv, zh }

export function texts(language: AppLanguage): Texts {
  return TEXTS[language] ?? en
}

export function duration(language: AppLanguage, ms: number): string {
  const t = texts(language)
  const seconds = Math.max(1, Math.round(ms / 1000))
  return seconds < 60 ? t.seconds(seconds) : t.minutes(Math.round(seconds / 60))
}

/** The first of the system's preferred languages that the app speaks, else English */
export function systemLanguage(preferred: readonly string[]): AppLanguage {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split(/[-_]/)[0]
    const language = LANGUAGES.find(l => l == base)
    if (language) return language
  }
  return 'en'
}
