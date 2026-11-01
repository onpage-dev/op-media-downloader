/** The log: one record per line whatever the message holds, written asynchronously, rotated at 5 MB */
import fs from 'fs'
import path from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { flushLog, log, logFile, logIdle, oneLine } from './log'

const user_data = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('fs')
  const { tmpdir } = await import('os')
  const { join } = await import('path')
  user_data.dir = mkdtempSync(join(tmpdir(), 'opmd-log-'))
  /** Packaged: nothing on the console but errors, no debug lines in the file */
  return { app: { getPath: () => user_data.dir, isPackaged: true } }
})

afterAll(() => {
  fs.rmSync(user_data.dir, { recursive: true, force: true })
})

async function until(condition: () => boolean): Promise<void> {
  const end = Date.now() + 5_000
  while (!met(condition)) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** While the log rotates main.log is missing until the next write: not met yet */
function met(condition: () => boolean): boolean {
  try {
    return condition()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code == 'ENOENT') return false
    throw error
  }
}

const lines = (file = logFile()): string[] => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)

describe('the log', () => {
  it('escapes line breaks', () => {
    expect(oneLine('a\nb\r\nc\u2028d\u2029e')).toBe('a\\nb\\r\\nc\\u2028d\\u2029e')
  })

  it('writes one record per line, without blocking, in order', async () => {
    expect(logFile()).toBe(path.join(user_data.dir, 'logs', 'main.log'))
    /** The installed app prints its errors on the console too */
    const console_line = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    log('info', 'first')
    log('warn', 'forged?\n2026-01-01T00:00:00.000Z ERROR this is not a record')
    log('error', 'with a cause', new Error('boom\nsecond line'))
    log('debug', 'not in the file of the installed app')
    expect(console_line).toHaveBeenCalledTimes(1)
    console_line.mockRestore()
    expect(fs.existsSync(logFile())).toBe(false)
    await until(() => fs.existsSync(logFile()) && lines().length == 3)
    const [first, forged, cause] = lines()
    expect(first).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z INFO first$/)
    expect(forged).toContain('WARN forged?\\n2026-01-01T00:00:00.000Z ERROR this is not a record')
    expect(cause).toContain('ERROR with a cause Error: boom\\nsecond line')
  })

  it('writes what is still queued at once when asked (the app exits)', async () => {
    // The lines of the earlier tests are written first: only this one is counted
    await until(logIdle)
    const before = lines().length
    log('info', 'last words')
    flushLog()
    expect(lines()).toHaveLength(before + 1)
    expect(lines().at(-1)).toContain('last words')
  })

  it('moves a full file to main.log.1', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024)
    log('info', `one ${big}`)
    await until(() => fs.statSync(logFile()).size > 3 * 1024 * 1024)
    log('info', `two ${big}`)
    await until(() => fs.existsSync(`${logFile()}.1`) && lines().some(line => line.includes('INFO two')))
    expect(lines()).toHaveLength(1)
    expect(lines(`${logFile()}.1`).at(-1)).toContain('INFO one xxx')
    expect(lines(`${logFile()}.1`)[0]).toContain('INFO first')
  })
})
