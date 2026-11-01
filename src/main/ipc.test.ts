/** The IPC handlers: one per channel, only for the app's windows, arguments checked before main uses them */
import path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { INVOKE, SEND } from '../shared/ipc-channels'
import { DEFAULT_SETTINGS } from '../shared/models'
import { IpcDeps, registerIpc } from './ipc'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
  opened: [] as string[],
  trusted: true,
}))

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '2.0.0', getPath: () => '/tmp' },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) =>
      electron.listeners.set(channel, listener),
  },
  BrowserWindow: { fromWebContents: () => null },
  clipboard: { writeText: () => undefined },
  dialog: {},
  net: {},
  shell: { openExternal: async (url: string) => void electron.opened.push(url), openPath: async () => '' },
}))
vi.mock('./log', () => ({ log: () => undefined }))
vi.mock('./security', async () => {
  const actual = await vi.importActual<typeof import('./security')>('./security')
  return { ...actual, isTrustedSender: () => electron.trusted }
})

const UUID = '0b6f8a52-3c1e-4c4a-9a51-7f0f4f6e2a10'
const event = {} as IpcMainInvokeEvent

let projects: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  electron.handlers.clear()
  electron.listeners.clear()
  electron.opened = []
  electron.trusted = true
  projects = {
    views: vi.fn(() => []),
    update: vi.fn(async () => ({ id: UUID })),
    inspect: vi.fn(async () => ({ problems: [] })),
    startJob: vi.fn(),
    getFailed: vi.fn(async () => ({ total: 0, entries: [] })),
  }
  const store = { settings: DEFAULT_SETTINGS, setSettings: vi.fn(patch => ({ ...DEFAULT_SETTINGS, ...patch })) }
  registerIpc({
    projects,
    store,
    status: () => ({ online: true, running_jobs: 0, speed_bps: 0, total_files: 0, total_bytes: 0 }),
    applySettings: () => undefined,
    broadcast: () => undefined,
    showMainWindow: () => undefined,
    quit: () => undefined,
  } as unknown as IpcDeps)
})

const invoke = (channel: string, ...args: unknown[]): unknown => electron.handlers.get(channel)!(event, ...args)

describe('the IPC handlers', () => {
  it('answer every channel of the preload', () => {
    expect([...electron.handlers.keys()].sort()).toEqual(Object.values(INVOKE).sort())
    expect([...electron.listeners.keys()].sort()).toEqual(Object.values(SEND).sort())
  })

  it('answer only the windows of the app', async () => {
    electron.trusted = false
    expect(() => invoke(INVOKE.projectsList)).toThrow('forbidden')
    expect(projects.views).not.toHaveBeenCalled()
  })

  it('never look a project up by a name every object has', () => {
    for (const id of ['constructor', '__proto__', 42, '../x'])
      expect(() => invoke(INVOKE.projectsUpdate, id, { label: 'x' }), String(id)).toThrow('invalid_input')
    expect(projects.update).not.toHaveBeenCalled()
  })

  it('pass checked arguments only', async () => {
    await invoke(INVOKE.projectsUpdate, UUID, { label: 'B', id: 'other', keep_old_files: 'yes' })
    expect(projects.update).toHaveBeenCalledWith(UUID, {
      label: 'B',
      token: undefined,
      folder: undefined,
      keep_old_files: undefined,
    })

    invoke(INVOKE.syncSync, UUID, { full_listing: 'yes', take_over_folder: 1 })
    expect(projects.startJob).toHaveBeenLastCalledWith(UUID, 'sync', { full_listing: false, take_over_folder: false })
    invoke(INVOKE.syncSync, UUID, { take_over_folder: true })
    expect(projects.startJob).toHaveBeenLastCalledWith(UUID, 'sync', { full_listing: false, take_over_folder: true })
    invoke(INVOKE.syncConfirmCleanup, UUID)
    expect(projects.startJob).toHaveBeenLastCalledWith(UUID, 'cleanup')

    await invoke(INVOKE.syncGetFailed, UUID, { offset: -1, limit: 10_000 })
    expect(projects.getFailed).toHaveBeenCalledWith(UUID, { offset: 0, limit: 200, query: undefined })

    expect(() => invoke(INVOKE.foldersInspect, 'relative/folder')).toThrow('invalid_input')
    await invoke(INVOKE.foldersInspect, path.resolve('Media'))
    expect(projects.inspect).toHaveBeenCalledWith(path.resolve('Media'), undefined)
  })

  it('open links to On Page and GitHub only', async () => {
    await expect(invoke(INVOKE.appOpenExternal, 'file:///C:/Windows/System32/calc.exe')).rejects.toThrow('invalid_url')
    await expect(invoke(INVOKE.appOpenExternal, 'https://evil.com/')).rejects.toThrow('invalid_url')
    await invoke(INVOKE.appOpenExternal, 'https://github.com/onpage-dev/op-media-downloader/releases')
    expect(electron.opened).toEqual(['https://github.com/onpage-dev/op-media-downloader/releases'])
  })

  it('save valid settings only', () => {
    expect(invoke(INVOKE.settingsSet, { theme: 'neon', concurrency: 50 })).toEqual({
      ...DEFAULT_SETTINGS,
      concurrency: 10,
    })
    expect(() => invoke(INVOKE.settingsSet, 'dark')).toThrow('invalid_input')
  })
})
