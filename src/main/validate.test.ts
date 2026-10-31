/** What the renderer sends is checked before main uses it */
import path from 'path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/models'
import {
  activityLimit,
  appCommand,
  cleanSettings,
  externalUrl,
  folderPath,
  newProjectInput,
  optionalFolder,
  optionalProjectId,
  pageQuery,
  projectId,
  projectPatch,
  settingsPatch,
  text,
} from './validate'

const ABSOLUTE = path.resolve('some', 'folder')
const UUID = '0b6f8a52-3c1e-4c4a-9a51-7f0f4f6e2a10'

describe('project ids', () => {
  it('accepts the ids of 1.x and 2.0', () => {
    expect(projectId(UUID)).toBe(UUID)
    expect(projectId('p1_A-b')).toBe('p1_A-b')
    expect(optionalProjectId(undefined)).toBeUndefined()
  })

  it('refuses anything else', () => {
    for (const value of [
      undefined,
      null,
      42,
      {},
      '',
      'a'.repeat(65),
      'a.b',
      'a/b',
      '../x',
      'a b',
      'projects.x',
      '__proto__',
      'constructor',
      'prototype',
    ])
      expect(() => projectId(value), String(value)).toThrow('invalid_input')
    expect(() => optionalProjectId('a.b')).toThrow('invalid_input')
  })
})

describe('texts and paths', () => {
  it('caps the length of strings', () => {
    expect(text('abc', 3)).toBe('abc')
    expect(() => text('abcd', 3)).toThrow('invalid_input')
    expect(() => text(3, 3)).toThrow('invalid_input')
  })

  it('wants absolute folders', () => {
    expect(folderPath(ABSOLUTE)).toBe(ABSOLUTE)
    for (const value of ['relative/folder', '.', '', 42, `${ABSOLUTE}\0x`, path.join(ABSOLUTE, 'a'.repeat(5_000))])
      expect(() => folderPath(value), String(value).slice(0, 40)).toThrow('invalid_input')
    expect(optionalFolder(ABSOLUTE)).toBe(ABSOLUTE)
    expect(optionalFolder('relative')).toBeUndefined()
    expect(optionalFolder(undefined)).toBeUndefined()
  })
})

describe('pages of long lists', () => {
  it('has defaults and bounds', () => {
    expect(pageQuery(undefined)).toEqual({ offset: 0, limit: 50, query: undefined })
    expect(pageQuery({ offset: -5, limit: 1e9, query: 'x'.repeat(500) })).toEqual({
      offset: 0,
      limit: 200,
      query: 'x'.repeat(200),
    })
    expect(pageQuery({ offset: 10.7, limit: 0, query: 3 })).toEqual({ offset: 10, limit: 1, query: undefined })
    expect(pageQuery({ offset: NaN, limit: Infinity })).toEqual({ offset: 0, limit: 50, query: undefined })
    expect(pageQuery({ offset: 1e300 }).offset).toBe(1_000_000_000)
  })

  it('reads at most the last 1,000 activity entries', () => {
    expect(activityLimit(undefined)).toBeUndefined()
    expect(activityLimit('10')).toBeUndefined()
    expect(activityLimit(5.5)).toBe(5)
    expect(activityLimit(1e6)).toBe(1_000)
    expect(activityLimit(-1)).toBe(1)
  })
})

describe('projects', () => {
  it('takes a new project with its flags as booleans only', () => {
    expect(newProjectInput({ label: 'A', token: 't', folder: ABSOLUTE, keep_old_files: 'yes', sync_now: true, x: 1 })).toEqual({
      label: 'A',
      token: 't',
      folder: ABSOLUTE,
      keep_old_files: false,
      sync_now: true,
    })
  })

  it('refuses a new project with a missing, long or relative field', () => {
    const valid = { label: 'A', token: 't', folder: ABSOLUTE }
    for (const input of [
      undefined,
      [],
      { ...valid, label: undefined },
      { ...valid, label: 'x'.repeat(501) },
      { ...valid, token: 'x'.repeat(2_001) },
      { ...valid, folder: 'relative' },
    ])
      expect(() => newProjectInput(input)).toThrow('invalid_input')
  })

  it('keeps only what a patch may change', () => {
    expect(projectPatch({ label: 'B', keep_old_files: true, id: 'other', folder: undefined })).toEqual({
      label: 'B',
      token: undefined,
      folder: undefined,
      keep_old_files: true,
    })
    expect(() => projectPatch({ folder: 'relative' })).toThrow('invalid_input')
    expect(() => projectPatch({ label: 3 })).toThrow('invalid_input')
    expect(() => projectPatch('x')).toThrow('invalid_input')
  })
})

describe('settings', () => {
  it('keeps valid values only, concurrency within 1..10', () => {
    expect(
      settingsPatch({
        theme: 'neon',
        language: 'pt',
        concurrency: 99,
        notifications: 'no',
        close_to_tray: true,
        unknown: 1,
      }),
    ).toEqual({ concurrency: 10, close_to_tray: true })
    expect(settingsPatch({ theme: 'dark', language: 'sv', concurrency: 2.6 })).toEqual({ theme: 'dark', language: 'sv', concurrency: 3 })
    expect(settingsPatch({ concurrency: NaN })).toEqual({})
    expect(settingsPatch({ concurrency: -3 })).toEqual({ concurrency: 1 })
    expect(() => settingsPatch(null)).toThrow('invalid_input')
  })

  it('reads settings back with the fallback for what is not valid', () => {
    expect(cleanSettings({ theme: 'neon', language: 'xx', concurrency: '4', notifications: false }, DEFAULT_SETTINGS)).toEqual({
      ...DEFAULT_SETTINGS,
      notifications: false,
    })
    expect(cleanSettings('garbage', DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS)
    expect(cleanSettings({ concurrency: 0 }, DEFAULT_SETTINGS).concurrency).toBe(1)
  })
})

describe('app commands', () => {
  it('passes the well-formed ones', () => {
    expect(appCommand({ type: 'sync_all', extra: 1 })).toEqual({ type: 'sync_all' })
    expect(appCommand({ type: 'select_project', project_id: UUID, tab: 'failed' })).toEqual({
      type: 'select_project',
      project_id: UUID,
      tab: 'failed',
    })
    expect(appCommand({ type: 'select_project', project_id: UUID, tab: 'nope' })).toEqual({
      type: 'select_project',
      project_id: UUID,
      tab: undefined,
    })
    expect(appCommand({ type: 'open_settings', section: 'updates' })).toEqual({ type: 'open_settings', section: 'updates' })
    expect(appCommand({ type: 'new_project', folder: ABSOLUTE })).toEqual({ type: 'new_project', folder: ABSOLUTE })
  })

  it('drops the others, and a relative folder', () => {
    for (const value of [undefined, 'sync_all', { type: 'format_disk' }, { type: 'select_project', project_id: '../x' }])
      expect(appCommand(value)).toBeUndefined()
    expect(appCommand({ type: 'new_project', folder: 'relative' })).toEqual({ type: 'new_project', folder: undefined })
  })
})

describe('links opened in the browser', () => {
  it('opens On Page and GitHub over https, normalized', () => {
    expect(externalUrl('https://app.onpage.it/#/things/edit/1/2/3/4')).toBe('https://app.onpage.it/#/things/edit/1/2/3/4')
    expect(externalUrl('HTTPS://APP.ONPAGE.IT/x')).toBe('https://app.onpage.it/x')
    expect(externalUrl('https://docs.onpage.it/')).toBe('https://docs.onpage.it/')
    expect(externalUrl('https://github.com/onpage-dev/op-media-downloader/releases/tag/v2.0.1')).toBe(
      'https://github.com/onpage-dev/op-media-downloader/releases/tag/v2.0.1',
    )
    expect(externalUrl('https://github.com:443/x')).toBe('https://github.com/x')
  })

  it('refuses everything else', () => {
    for (const value of [
      undefined,
      42,
      'not a url',
      'http://app.onpage.it/',
      'javascript:alert(1)',
      'file:///C:/Windows/System32/calc.exe',
      'https://evil.com/',
      'https://onpage.it.evil.com/',
      'https://evilonpage.it/',
      'https://gist.github.com/',
      'https://user:pass@app.onpage.it/',
      'https://app.onpage.it@evil.com/',
      'https://app.onpage.it:8443/',
      `https://app.onpage.it/${'x'.repeat(3_000)}`,
    ])
      expect(externalUrl(value), String(value).slice(0, 40)).toBeUndefined()
  })
})
