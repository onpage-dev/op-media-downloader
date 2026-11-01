import type { AppLanguage } from '../../shared/models'

/** The forms of a text with a number, by plural category (CLDR) */
export interface PluralForms {
  one?: string
  few?: string
  many?: string
  other: string
}

/** The form for count in language: Russian has one, few and many; French says «0 fichier» */
export function plural(language: AppLanguage, count: number, forms: PluralForms): string {
  const category = new Intl.PluralRules(language).select(count)
  return (category == 'one' || category == 'few' || category == 'many' ? forms[category] : undefined) ?? forms.other
}
