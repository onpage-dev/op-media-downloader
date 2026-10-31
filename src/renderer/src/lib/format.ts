/** Numbers, sizes, speeds, durations and dates in the app's language */
import { i18n } from '../i18n'

const t = i18n.global.t
const locale = (): string => i18n.global.locale.value

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(locale()).format(value)
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']
export function formatBytes(bytes?: number): string {
  if (bytes == null) return '—'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const digits = unit == 0 || value >= 100 ? 0 : 1
  const number = new Intl.NumberFormat(locale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
  return `${number} ${UNITS[unit]}`
}

export const formatSpeed = (bytes_per_second: number): string => `${formatBytes(bytes_per_second)}/s`

/** «circa 6 minuti», «circa 1 h 20 min», «meno di un minuto» */
export function formatEta(seconds?: number): string {
  if (seconds == null) return ''
  if (seconds < 60) return t('time.less_than_minute')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('time.about_minutes', { n: minutes }, minutes)
  return t('time.about_hours', { h: Math.floor(minutes / 60), m: minutes % 60 })
}

/** «6 min», «1 h 20 min», «< 1 min»: the time left in a table cell */
export function formatEtaShort(seconds?: number): string {
  if (seconds == null) return ''
  if (seconds < 60) return '< 1 min'
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

const time = (date: Date): string =>
  new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(date)

/** «12:04:31», for the activity log */
export function formatClock(iso: string): string {
  return new Intl.DateTimeFormat(locale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso))
}

/** «adesso», «5 min fa», «oggi, 10:31», «ieri, 18:09», «28 ott, 18:09», «28 ott 2025» */
export function formatWhen(iso?: string, now = new Date()): string {
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
    const d = new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short' }).format(date)
    return `${d}, ${time(date)}`
  }
  return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
}

/** «10:02», the hour a job started */
export const formatHour = (iso: string): string => time(new Date(iso))
