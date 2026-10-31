/**
 * A small file logger for support: `userData/logs/main.log`, rotated at 5 MB.
 * Per-file details stay out of it: only jobs, errors and their causes.
 */
import { app } from 'electron'
import fs from 'fs'
import path from 'path'

type Level = 'debug' | 'info' | 'warn' | 'error'

const MAX_BYTES = 5 * 1024 * 1024
let file: string | undefined

function target(): string {
  if (!file) {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    file = path.join(dir, 'main.log')
  }
  return file
}

export function logFolder(): string {
  return path.dirname(target())
}

export function log(level: Level, message: string, error?: unknown): void {
  const detail =
    error instanceof Error ? ` ${error.stack ?? error.message}` : error ? ` ${String(error)}` : ''
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${detail}\n`
  if (!app.isPackaged || level == 'error') process.stdout.write(line)
  if (level == 'debug' && app.isPackaged) return
  try {
    const out = target()
    if (fs.existsSync(out) && fs.statSync(out).size > MAX_BYTES) {
      fs.renameSync(out, `${out}.1`)
    }
    fs.appendFileSync(out, line)
  } catch {
    /** Logging must never break the app */
  }
}
