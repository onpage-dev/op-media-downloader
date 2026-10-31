/** The store: 1.x migration, a damaged file set aside, values checked when read, tokens */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/models'
import { AppStore, StoredProject } from './store'

/** safeStorage stand-in: «encrypts» as `enc:<token>`; `old:<token>` is a key the system rotated; anything else fails */
const electron = vi.hoisted(() => ({ encryption: true }))

vi.mock('electron', () => {
  const api = {
    app: { getPath: () => os.tmpdir(), getVersion: () => '2.0.0', isPackaged: false },
    ipcMain: { on: () => undefined },
    shell: {},
    safeStorage: {
      isAsyncEncryptionAvailable: async () => electron.encryption,
      encryptStringAsync: async (text: string) => Buffer.from(`enc:${text}`),
      decryptStringAsync: async (buffer: Buffer) => {
        const text = buffer.toString()
        if (!/^(enc|old):/.test(text)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.')
        return { result: text.slice(4), shouldReEncrypt: text.startsWith('old:') }
      },
    },
  }
  return { ...api, default: api }
})
vi.mock('./log', () => ({ log: () => undefined }))

const A = '0b6f8a52-3c1e-4c4a-9a51-7f0f4f6e2a10'
const B = '5d1c2e7a-9f4b-4b8e-8c3d-2a6f1e0b9c47'
const C = 'a3e9c1d5-7b2f-4e6a-9d8c-1f0e2b3a4c5d'
const D = 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b'

const dirs: string[] = []
let dir: string

beforeEach(() => {
  electron.encryption = true
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opmd-store-'))
  dirs.push(dir)
})

afterAll(() => {
  for (const created of dirs) fs.rmSync(created, { recursive: true, force: true })
})

const configFile = (): string => path.join(dir, 'op-media-downloader-config.json')
const writeConfig = (value: unknown): void =>
  fs.writeFileSync(configFile(), typeof value == 'string' ? value : JSON.stringify(value, null, 2))
const readConfig = (): Record<string, any> => JSON.parse(fs.readFileSync(configFile(), 'utf8'))
const encrypted = (token: string): string => Buffer.from(`enc:${token}`).toString('base64')

function project(id: string, extra: Partial<StoredProject> = {}): StoredProject {
  return {
    id,
    label: `Project ${id.slice(0, 4)}`,
    folder: path.resolve('projects', id),
    keep_old_files: false,
    created_at: '2026-01-01T00:00:00.000Z',
    token_enc: encrypted(`token-${id}`),
    ...extra,
  }
}

describe('a new install', () => {
  it('starts with the defaults in the language of the system', () => {
    const store = new AppStore({ cwd: dir, default_language: 'fr' })
    expect(store.settings).toEqual({ ...DEFAULT_SETTINGS, language: 'fr' })
    expect(store.projects).toEqual([])
    expect(readConfig()).toEqual({ version: 2, settings: { ...DEFAULT_SETTINGS, language: 'fr' }, projects: {} })
  })
})

describe('the 1.x migration', () => {
  const V1 = {
    storage_data: {
      [A]: {
        id: A,
        label: 'Catalogo',
        api_token: 'token-a',
        folder_path: path.resolve('Foto'),
        keep_old_files: true,
        last_sync: {
          start_time: '2024-05-01 10:00:00',
          end_time: '2024-05-01 10:05:00',
          downloaded: 10,
          failed: 2,
          already_exists: 5,
          total: 17,
        },
      },
      [B]: {
        id: B,
        label: 'Listino',
        api_token: 'token-b',
        folder_path: path.resolve('Listino'),
        keep_old_files: false,
      },
      broken: 'not a project',
      no_folder: { id: 'x', label: 'x', api_token: 't' },
    },
    user_properties: { dark_mode: true, simultaneous_downloads: 50, language: 'en' },
  }

  it('moves projects and settings, encrypts the tokens and drops the 1.x keys', async () => {
    writeConfig(V1)
    const store = new AppStore({ cwd: dir, default_language: 'de' })
    await store.unlockTokens()

    expect(store.projects.map(p => [p.id, p.label, p.keep_old_files])).toEqual([
      [A, 'Catalogo', true],
      [B, 'Listino', false],
    ])
    const [first] = store.projects
    expect(store.token(first)).toBe('token-a')
    expect(first.token_plain).toBeUndefined()
    expect(first.last_result).toMatchObject({
      job: 'download',
      outcome: 'completed',
      downloaded: 10,
      failed: 2,
      already_present: 5,
      total: 17,
    })
    expect(store.settings).toMatchObject({ theme: 'dark', language: 'en', concurrency: 10 })

    const file = fs.readFileSync(configFile(), 'utf8')
    expect(file).not.toContain('token-a')
    expect(file).not.toContain('token-b')
    expect(Object.keys(readConfig()).sort()).toEqual(['projects', 'settings', 'version'])
    expect(readConfig().version).toBe(2)
  })

  it('reads 1.x defaults as 2.0 defaults', () => {
    writeConfig({ storage_data: {}, user_properties: { simultaneous_downloads: 1 } })
    const store = new AppStore({ cwd: dir, default_language: 'de' })
    /** 1.x showed Italian unless told otherwise; 1 download at a time was its default */
    expect(store.settings).toMatchObject({ theme: 'system', language: 'it', concurrency: DEFAULT_SETTINGS.concurrency })
  })

  it('keeps the tokens in clear where the system has no encryption', async () => {
    electron.encryption = false
    writeConfig(V1)
    const store = new AppStore({ cwd: dir })
    await store.unlockTokens()
    expect(store.projects[0]).toMatchObject({ token_plain: 'token-a', token_enc: undefined })
    expect(store.hasToken(store.projects[0])).toBe(true)
  })

  it('imports the projects 1.x added after the migration and removes its keys again', async () => {
    writeConfig({
      version: 2,
      settings: { ...DEFAULT_SETTINGS, theme: 'light' },
      projects: { [A]: project(A, { folder: path.resolve('Foto') }) },
      storage_data: {
        [A]: { id: A, label: 'Again', api_token: 'x', folder_path: path.resolve('Foto') },
        [C]: { id: C, label: 'New in 1.x', api_token: 'token-c', folder_path: path.resolve('Nuovo') },
        [D]: { id: D, label: 'Same folder', api_token: 'x', folder_path: path.resolve('Foto') + path.sep },
      },
      user_properties: { dark_mode: true },
    })
    const store = new AppStore({ cwd: dir })
    await store.unlockTokens()
    expect(store.projects.map(p => p.id).sort()).toEqual([A, C].sort())
    expect(store.project(A)?.label).toBe(`Project ${A.slice(0, 4)}`)
    expect(store.token(store.project(C)!)).toBe('token-c')
    /** The 2.0 settings stay */
    expect(store.settings.theme).toBe('light')
    expect(readConfig()).not.toHaveProperty('storage_data')
    expect(readConfig()).not.toHaveProperty('user_properties')
  })
})

describe('a damaged config file', () => {
  it('is set aside and the app starts without projects', () => {
    writeConfig('{"version": 2, "projects": {"a": ')
    const store = new AppStore({ cwd: dir, default_language: 'sv' })
    expect(store.set_aside).toBeDefined()
    expect(path.basename(store.set_aside!)).toMatch(/^op-media-downloader-config\.corrupt-[\dTZ-]+\.json$/)
    expect(fs.readFileSync(store.set_aside!, 'utf8')).toBe('{"version": 2, "projects": {"a": ')
    expect(store.projects).toEqual([])
    expect(store.settings.language).toBe('sv')
    expect(readConfig().version).toBe(2)
  })

  it('also when it is empty (cut by a power failure)', () => {
    writeConfig('')
    const store = new AppStore({ cwd: dir })
    expect(store.set_aside).toBeDefined()
    expect(store.projects).toEqual([])
  })

  it('a readable one is not', () => {
    writeConfig({ version: 2, settings: DEFAULT_SETTINGS, projects: {} })
    expect(new AppStore({ cwd: dir }).set_aside).toBeUndefined()
  })
})

describe('values read back', () => {
  it('have defaults for anything not valid', () => {
    writeConfig({
      version: 2,
      settings: { theme: 'neon', language: 'pt', concurrency: 99, notifications: 'no', close_to_tray: true },
      projects: {},
      window_state: { width: 'wide', height: 700 },
    })
    const store = new AppStore({ cwd: dir, default_language: 'es' })
    expect(store.settings).toEqual({ ...DEFAULT_SETTINGS, language: 'es', concurrency: 10, close_to_tray: true })
    expect(store.windowState).toBeUndefined()
  })

  it('only count projects that are projects', () => {
    writeConfig({
      version: 2,
      settings: DEFAULT_SETTINGS,
      projects: {
        [A]: project(A),
        [B]: { ...project(B), id: C },
        'not an id!': project('not an id!'),
        [D]: { id: D, folder: '/x' },
        toString: 'nothing',
      },
    })
    const store = new AppStore({ cwd: dir })
    expect(store.projects.map(p => p.id)).toEqual([A])
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', B, D])
      expect(store.project(id), id).toBeUndefined()
  })

  it('a projects entry that is not a map is no projects', () => {
    writeConfig({ version: 2, settings: DEFAULT_SETTINGS, projects: [project(A)] })
    const store = new AppStore({ cwd: dir })
    expect(store.projects).toEqual([])
    store.saveProject(project(B))
    expect(store.projects.map(p => p.id)).toEqual([B])
  })

  it('never saves a project under a name every object has', () => {
    const store = new AppStore({ cwd: dir })
    for (const id of ['__proto__', 'constructor', 'a.b'])
      expect(() => store.saveProject(project(id))).toThrow('invalid_input')
    expect(store.patchProject('constructor', { label: 'x' })).toBeUndefined()
    store.removeProject('constructor')
    expect(readConfig().projects).toEqual({})
  })

  it('come from the cache, frozen, and follow every write', () => {
    const store = new AppStore({ cwd: dir })
    store.saveProject(project(A, { plan: { remote_names: 1 } as StoredProject['plan'] }))
    const read = store.project(A)!
    expect(() => {
      ;(read.plan as { remote_names: number }).remote_names = 2
    }).toThrow(TypeError)
    store.patchProject(A, { label: 'Renamed' })
    expect(store.project(A)?.label).toBe('Renamed')
    store.removeProject(A)
    expect(store.project(A)).toBeUndefined()
  })
})

describe('tokens', () => {
  it('a token that cannot be decrypted counts as none', async () => {
    writeConfig({
      version: 2,
      settings: DEFAULT_SETTINGS,
      projects: {
        [A]: project(A),
        [B]: project(B, { token_enc: Buffer.from('from another computer').toString('base64') }),
        [C]: project(C, { token_enc: encrypted('') }),
      },
    })
    const store = new AppStore({ cwd: dir })
    await store.unlockTokens()
    expect(store.hasToken(store.project(A)!)).toBe(true)
    expect(store.hasToken(store.project(B)!)).toBe(false)
    expect(store.token(store.project(B)!)).toBe('')
    expect(store.hasToken(store.project(C)!)).toBe(false)
  })

  it('tokens saved in clear are encrypted once the system can', async () => {
    writeConfig({
      version: 2,
      settings: DEFAULT_SETTINGS,
      projects: { [A]: project(A, { token_enc: undefined, token_plain: 'clear-a' }) },
    })
    const store = new AppStore({ cwd: dir })
    await store.unlockTokens()
    expect(store.project(A)).toMatchObject({ token_enc: encrypted('clear-a'), token_plain: undefined })
    expect(store.token(store.project(A)!)).toBe('clear-a')
    expect(fs.readFileSync(configFile(), 'utf8')).not.toContain('clear-a')
  })

  it('stay in clear while it cannot', async () => {
    electron.encryption = false
    writeConfig({
      version: 2,
      settings: DEFAULT_SETTINGS,
      projects: { [A]: project(A, { token_enc: undefined, token_plain: 'clear-a' }) },
    })
    const store = new AppStore({ cwd: dir })
    await store.unlockTokens()
    expect(store.project(A)?.token_plain).toBe('clear-a')
    expect(store.hasToken(store.project(A)!)).toBe(true)
  })

  it('a token whose key the system rotated is encrypted again, the others stay as they are', async () => {
    const rotated = Buffer.from('old:token-a').toString('base64')
    writeConfig({
      version: 2,
      settings: DEFAULT_SETTINGS,
      projects: { [A]: project(A, { token_enc: rotated }), [B]: project(B) },
    })
    const store = new AppStore({ cwd: dir })
    // Nothing is read before the tokens are unlocked
    expect(store.token(store.project(A)!)).toBe('')
    await store.unlockTokens()
    expect(store.project(A)?.token_enc).toBe(encrypted('token-a'))
    expect(store.token(store.project(A)!)).toBe('token-a')
    expect(store.project(B)?.token_enc).toBe(encrypted(`token-${B}`))
    expect(store.token(store.project(B)!)).toBe(`token-${B}`)
  })

  it('a token saved now is read back without decrypting it again', async () => {
    const store = new AppStore({ cwd: dir })
    const saved = await store.encryptToken('new-token')
    expect(saved).toEqual({ token_enc: encrypted('new-token'), token_plain: undefined })
    store.saveProject(project(A, saved))
    expect(store.token(store.project(A)!)).toBe('new-token')
    electron.encryption = false
    expect(await store.encryptToken('plain')).toEqual({ token_enc: undefined, token_plain: 'plain' })
  })
})
