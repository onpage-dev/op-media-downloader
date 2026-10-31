/** Sizes, speeds, durations, percentages and names in the language's words; main's error codes in the user's */
import { afterEach, describe, expect, it } from 'vitest'
import type { AppLanguage } from '@shared/models'
import { i18n } from '../i18n'
import { errorCode, errorText } from './errors'
import { compareText, formatBytes, formatEta, formatEtaShort, formatPercent, formatSpeed, formatWhen } from './format'

const speak = (language: AppLanguage): void => {
  i18n.global.locale.value = language
}
const t = i18n.global.t
const MB = 1024 ** 2

afterEach(() => speak('it'))

describe('formats', () => {
  it('writes sizes and speeds with the units of the language, in multiples of 1024', () => {
    expect(formatBytes(512)).toBe('512 byte')
    expect(formatBytes(930 * 1024)).toBe('930 kB')
    expect(formatBytes(4.2 * MB)).toBe('4,2 MB')
    expect(formatBytes(150 * 1024 * MB)).toBe('150 GB')
    expect(formatBytes(undefined)).toBe('—')
    expect(formatSpeed(4.2 * MB)).toBe('4,2 MB/s')
    speak('en')
    expect(formatBytes(4.2 * MB)).toBe('4.2 MB')
    speak('fr')
    expect(formatBytes(4.2 * MB)).toMatch(/^4,2\sMo$/u)
    expect(formatSpeed(4.2 * MB)).toMatch(/^4,2\sMo\/s$/u)
  })

  it('writes percentages rounded down, as the language writes them', () => {
    expect(formatPercent(0.429)).toBe('42%')
    expect(formatPercent(1.2)).toBe('100%')
    speak('fr')
    expect(formatPercent(0.42)).toMatch(/^42\s%$/u)
  })

  it('writes the time left with the names of the units, never «min» by hand', () => {
    expect(formatEta(30)).toBe(t('time.less_than_minute'))
    expect(formatEta(4800)).toMatch(/^circa 1 \p{L}+.* 20 \p{L}+$/u)
    expect(formatEtaShort(362)).toMatch(/^6\s?\p{L}+$/u)
    expect(formatEtaShort(20)).toMatch(/^< 1\s?\p{L}+$/u)
    expect(formatEta(undefined)).toBe('')
  })

  it('orders names with their numbers by value', () => {
    expect(['Foto 10', 'foto 2', 'Archivio'].sort(compareText)).toEqual(['Archivio', 'foto 2', 'Foto 10'])
  })

  it('counts relative times from the time it is given', () => {
    const now = new Date(2026, 9, 31, 12, 0)
    const ago = (minutes: number): string => new Date(now.getTime() - minutes * 60000).toISOString()
    expect(formatWhen(ago(0), now)).toBe(t('time.now'))
    expect(formatWhen(ago(5), now)).toBe(t('time.minutes_ago', { n: 5 }))
    expect(formatWhen(undefined, now)).toBe('')
  })
})

describe('errors', () => {
  it('gives a code its own words, also with a detail after it', () => {
    expect(errorText(new Error('project_busy'))).toBe(t('errors.project_busy'))
    expect(errorText(new Error('engine_timeout:sync'))).toBe(t('errors.engine_timeout'))
    expect(errorCode(new Error('engine_timeout:sync'))).toBe('engine_timeout')
  })

  it('names a folder problem with the title of its check', () => {
    expect(errorText(new Error('folder_protected'))).toBe(t('check.protected.title'))
  })

  it('names any other code in the generic text, and never shows a message that is not a code', () => {
    expect(errorText(new Error('engine_crashed'))).toBe(t('errors.generic', { detail: 'engine_crashed' }))
    expect(errorText(new Error("Error invoking remote method 'x': TypeError: boom"))).toBe(
      t('errors.generic', { detail: 'unexpected' }),
    )
    expect(errorText('generic')).toBe(t('errors.generic', { detail: 'generic' }))
  })
})
