/**
 * Numbers, sizes, speeds, durations, percentages and dates in the app's
 * language, all through Intl: the units, the separators and the order of the
 * words are the language's. A formatter is built once per language and kind
 * (building one costs far more than using it: a list of thousands of rows
 * formats a size on each).
 */
import { ref } from 'vue'
import { i18n } from '../i18n'

const t = i18n.global.t
const locale = (): string => i18n.global.locale.value

const formatters = new Map<string, unknown>()
function cached<T>(kind: string, make: (locale: string) => T): T {
  const key = `${locale()}|${kind}`
  let formatter = formatters.get(key) as T | undefined
  if (!formatter) formatters.set(key, (formatter = make(locale())))
  return formatter
}

export function formatNumber(value: number): string {
  return cached('number', l => new Intl.NumberFormat(l)).format(value)
}

/** Multiples of 1024, as Windows counts them: «930 kB», «4,2 MB», «31,8 GB» (in French «Mo», «Go») */
const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const
function bytesIn(bytes: number, per: '' | '-per-second'): string {
  let value = bytes
  let step = 0
  while (value >= 1024 && step < BYTE_UNITS.length - 1) {
    value /= 1024
    step++
  }
  const digits = step == 0 || value >= 100 ? 0 : 1
  const unit = `${BYTE_UNITS[step]}${per}`
  return cached(
    `unit:${unit}:${digits}`,
    l =>
      new Intl.NumberFormat(l, {
        style: 'unit',
        unit,
        unitDisplay: 'short',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }),
  ).format(value)
}

export function formatBytes(bytes?: number): string {
  return bytes == null ? '—' : bytesIn(bytes, '')
}

/** «4,2 MB/s» */
export const formatSpeed = (bytes_per_second: number): string => bytesIn(bytes_per_second, '-per-second')

/** «42%», «42 %»: a share from 0 to 1, rounded down (a job is not done before it is) */
export function formatPercent(share: number): string {
  const whole = Math.floor(Math.min(1, Math.max(0, share)) * 100)
  return cached('percent', l => new Intl.NumberFormat(l, { style: 'percent', maximumFractionDigits: 0 })).format(
    whole / 100,
  )
}

/** Minutes as hours and minutes: `long` in a sentence («1 ora e 20 minuti»), `narrow` in a table cell («1h 20min») */
function duration(minutes: number, style: 'long' | 'narrow'): string {
  const parts = minutes < 60 ? { minutes } : { hours: Math.floor(minutes / 60), minutes: minutes % 60 }
  if (typeof Intl.DurationFormat == 'function') {
    return cached(`duration:${style}`, l => new Intl.DurationFormat(l, { style })).format(parts)
  }
  // Engines without Intl.DurationFormat (Node in the tests): each unit with its name, side by side
  return Object.entries(parts)
    .filter(([, value]) => value > 0)
    .map(([unit, value]) =>
      cached(
        `unit:${unit}:${style}`,
        l => new Intl.NumberFormat(l, { style: 'unit', unit: unit.slice(0, -1), unitDisplay: style }),
      ).format(value),
    )
    .join(' ')
}

/** «circa 6 minuti», «circa 1 ora e 20 minuti», «meno di un minuto» */
export function formatEta(seconds?: number): string {
  if (seconds == null) return ''
  if (seconds < 60) return t('time.less_than_minute')
  return t('time.about', { duration: duration(Math.round(seconds / 60), 'long') })
}

/** «6min», «1h 20min», «< 1min»: the time left in a table cell */
export function formatEtaShort(seconds?: number): string {
  if (seconds == null) return ''
  if (seconds < 60) return `< ${duration(1, 'narrow')}`
  return duration(Math.round(seconds / 60), 'narrow')
}

/** Names and folders in the language's order, the numbers in them by value («Foto 2» before «Foto 10») */
export const compareText = (a: string, b: string): number =>
  cached('collator', l => new Intl.Collator(l, { numeric: true })).compare(a, b)

const time = (date: Date): string =>
  cached('time', l => new Intl.DateTimeFormat(l, { hour: '2-digit', minute: '2-digit' })).format(date)

/** «12:04:31», for the activity log */
export function formatClock(iso: string): string {
  return cached(
    'clock',
    l => new Intl.DateTimeFormat(l, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  ).format(new Date(iso))
}

/**
 * The time the relative dates are counted from, a tick every 30 seconds: what
 * says «adesso» or «5 min fa» renders again as the minutes pass. It starts with
 * the first date that needs it.
 */
const clock = ref(Date.now())
let ticking: ReturnType<typeof setInterval> | undefined
function currentTime(): Date {
  ticking ??= setInterval(() => (clock.value = Date.now()), 30_000)
  return new Date(clock.value)
}

/** «adesso», «5 min fa», «oggi, 10:31», «ieri, 18:09», «28 ott, 18:09», «28 ott 2025» */
export function formatWhen(iso?: string, now = currentTime()): string {
  if (!iso) return ''
  const date = new Date(iso)
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000)
  if (minutes < 1) return t('time.now')
  if (minutes < 60) return t('time.minutes_ago', { n: minutes })
  const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(now) - day(date)) / 86400000)
  if (days == 0) return t('time.today', { time: time(date) })
  if (days == 1) return t('time.yesterday', { time: time(date) })
  if (date.getFullYear() == now.getFullYear()) {
    const d = cached('day', l => new Intl.DateTimeFormat(l, { day: 'numeric', month: 'short' })).format(date)
    return `${d}, ${time(date)}`
  }
  return cached('date', l => new Intl.DateTimeFormat(l, { day: 'numeric', month: 'short', year: 'numeric' })).format(
    date,
  )
}

/** «10:02», the hour a job started */
export const formatHour = (iso: string): string => time(new Date(iso))
