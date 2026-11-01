/** Every language has the messages of Italian, with its placeholders, and the plural forms of the language */
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { type AppLanguage, LANGUAGES } from '@shared/models'
import { PLURAL_FORMS, pluralRule } from './plural'

type Messages = { [key: string]: string | Messages }

const dir = path.dirname(fileURLToPath(import.meta.url))
const load = (language: string): Messages => JSON.parse(readFileSync(path.join(dir, `${language}.json`), 'utf8'))
const flat = (messages: Messages, prefix = ''): [string, string][] =>
  Object.entries(messages).flatMap(([key, value]) =>
    typeof value == 'string' ? [[prefix + key, value] as [string, string]] : flat(value, `${prefix}${key}.`),
  )
const placeholders = (text: string): string[] => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort()

const italian = new Map(flat(load('it')))
const english = new Map(flat(load('en')))
/** The messages shown with a number: plural in Italian or in English */
const plurals = [...italian.keys()].filter(key => italian.get(key)!.includes('|') || english.get(key)!.includes('|'))

describe.each(LANGUAGES)('%s messages', (language: AppLanguage) => {
  const messages = new Map(flat(load(language)))

  it('has the keys of Italian, no more, no less', () => {
    expect([...messages.keys()].sort()).toEqual([...italian.keys()].sort())
  })

  it('keeps the placeholders of Italian', () => {
    for (const [key, text] of italian) expect(placeholders(messages.get(key) ?? ''), key).toEqual(placeholders(text))
  })

  it('has the plural forms of the language, each with the number', () => {
    if (language == 'it' || language == 'en') return
    for (const key of plurals) {
      const forms = messages.get(key)!.split('|')
      expect(forms.length, key).toBe(PLURAL_FORMS[language].length)
      const number = placeholders(italian.get(key)!).find(p => p == '{count}' || p == '{n}')
      for (const form of forms) if (number) expect(form, key).toContain(number)
    }
  })

  it('renders every message', () => {
    const i18n = createI18n({
      legacy: false,
      locale: language,
      messages: { [language]: load(language) },
      pluralRules: { [language]: pluralRule(language) },
      missingWarn: false,
      fallbackWarn: false,
    })
    for (const [key, text] of messages) {
      const named = Object.fromEntries(placeholders(text).map(p => [p.slice(1, -1), 'x']))
      for (const count of plurals.includes(key) ? [0, 1, 2, 3, 5, 11, 21, 22, 25, 1000000] : [1]) {
        const out = i18n.global.t(key, named, count)
        expect(out, key).not.toBe(key)
        expect(out, key).not.toMatch(/[{}|@]/)
      }
    }
  })
})

describe('plural rules', () => {
  const form = (language: AppLanguage, count: number): number =>
    pluralRule(language)(count, PLURAL_FORMS[language].length)

  it('Russian: one, few, many', () => {
    expect([1, 21, 101].map(n => form('ru', n))).toEqual([0, 0, 0])
    expect([2, 3, 4, 22, 34].map(n => form('ru', n))).toEqual([1, 1, 1, 1, 1])
    expect([0, 5, 11, 12, 14, 25, 111].map(n => form('ru', n))).toEqual([2, 2, 2, 2, 2, 2, 2])
  })

  it('French: 0 and 1 are singular; Italian and English: only 1', () => {
    expect([0, 1, 2].map(n => form('fr', n))).toEqual([0, 0, 1])
    expect([0, 1, 2, 1000000].map(n => form('it', n))).toEqual([1, 0, 1, 1])
    expect([0, 1, 2].map(n => form('en', n))).toEqual([1, 0, 1])
  })

  it('Chinese: one form; a message with fewer forms takes its last one', () => {
    expect([0, 1, 2].map(n => form('zh', n))).toEqual([0, 0, 0])
    expect(pluralRule('ru')(5, 2)).toBe(1)
    expect(pluralRule('it')(5, 1)).toBe(0)
  })
})
