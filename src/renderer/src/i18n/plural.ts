/**
 * Plural messages list their forms, separated by « | », in the order of the
 * language's plural categories (CLDR, through Intl.PluralRules); a message
 * with one form is the same for every number.
 */
import type { AppLanguage } from '@shared/models'

export const PLURAL_FORMS: Record<AppLanguage, Intl.LDMLPluralRule[]> = {
  it: ['one', 'other'],
  en: ['one', 'other'],
  de: ['one', 'other'],
  es: ['one', 'other'],
  fr: ['one', 'other'],
  ru: ['one', 'few', 'many'],
  sv: ['one', 'other'],
  zh: ['other'],
}

export function pluralRule(language: AppLanguage): (choice: number, choicesLength: number) => number {
  const rules = new Intl.PluralRules(language)
  const forms = PLURAL_FORMS[language]
  return (choice, choicesLength) => {
    const index = forms.indexOf(rules.select(Math.abs(choice)))
    // A category with no form of its own («many» for millions in it, es and fr) takes the last one
    return Math.min(index < 0 ? forms.length - 1 : index, choicesLength - 1)
  }
}
