/**
 * A small file logger for support: `userData/logs/main.log`, rotated at 5 MB
 * (the previous file is `main.log.1`). Per-file details stay out of it: only
 * jobs, errors and their causes. Lines are queued and appended a batch at a
 * time, asynchronously, so a burst of logs never blocks the main process; a
 * record is one line, whatever its message holds.
 */
import { app } from 'electron'
import fs from 'fs'
import path from 'path'

type Level = 'debug' | 'info' | 'warn' | 'error'

const MAX_BYTES = 5 * 1024 * 1024
/** CR, LF and the Unicode line and paragraph separators would forge records: they are written escaped */
const LINE_BREAKS = /[\r\n\u2028\u2029]/g

let file: string | undefined
/** Bytes in the file, read once before the first write */
let size: number | undefined
let queue: string[] = []
/** The batch being appended asynchronously */
let in_flight: string | undefined
let writing = false

/** Nothing queued and nothing being written */
export function logIdle(): boolean {
  return !queue.length && in_flight === undefined
}

export function logFile(): string {
  file ??= path.join(app.getPath('userData'), 'logs', 'main.log')
  return file
}

export function oneLine(text: string): string {
  return text.replace(LINE_BREAKS, char => (char == '\r' ? '\\r' : char == '\n' ? '\\n' : `\\u${char.charCodeAt(0).toString(16)}`))
}

export function log(level: Level, message: string, error?: unknown): void {
  const detail =
    error instanceof Error
      ? ` ${error.stack ?? error.message}`
      : error
        ? ` ${typeof error == 'string' ? error : JSON.stringify(error)}`
        : ''
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${oneLine(message + detail)}\n`
  if (!app.isPackaged || level == 'error') {
    try {
      process.stdout.write(line)
    } catch {
      /** No console */
    }
  }
  if (level == 'debug' && app.isPackaged) return
  queue.push(line)
  if (!writing) {
    /** Lines logged in the same turn go out together */
    writing = true
    setImmediate(() => void drain())
  }
}

/**
 * Writes what is still queued, synchronously: the process is about to end. A
 * batch the asynchronous writer has in hand is written too, since it may not
 * make it in time (at worst it is in the file twice).
 */
export function flushLog(): void {
  const chunk = (in_flight ?? '') + queue.join('')
  in_flight = undefined
  queue = []
  if (!chunk) return
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true })
    fs.appendFileSync(logFile(), chunk)
    if (size !== undefined) size += Buffer.byteLength(chunk)
  } catch {
    /** Logging must never break the app */
  }
}

process.on('exit', flushLog)

async function drain(): Promise<void> {
  try {
    while (queue.length) {
      const chunk = queue.join('')
      queue = []
      in_flight = chunk
      await append(chunk)
      in_flight = undefined
    }
  } finally {
    in_flight = undefined
    writing = false
  }
}

async function append(chunk: string): Promise<void> {
  try {
    const out = logFile()
    if (size === undefined) {
      await fs.promises.mkdir(path.dirname(out), { recursive: true })
      size = await fs.promises.stat(out).then(
        stat => stat.size,
        () => 0,
      )
    }
    const bytes = Buffer.byteLength(chunk)
    if (size > 0 && size + bytes > MAX_BYTES) {
      /** A file that cannot be renamed now (open in a viewer) keeps growing until it can */
      await fs.promises.rename(out, `${out}.1`).then(
        () => (size = 0),
        () => undefined,
      )
    }
    await fs.promises.appendFile(out, chunk)
    size += bytes
  } catch {
    /** Logging must never break the app: the size is read again next time */
    size = undefined
  }
}
