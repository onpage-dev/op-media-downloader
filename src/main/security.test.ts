/** Who may talk to main, what the pages may ask for, the switches the installed app refuses */
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent, Session, WebContents } from 'electron'
import { debugSwitch, denyPermissions, isTrustedSender, secureContents } from './security'

const electron = vi.hoisted(() => ({ opened: [] as string[] }))

vi.mock('electron', () => ({
  app: { isPackaged: true, commandLine: { hasSwitch: () => false } },
  shell: { openExternal: async (url: string) => void electron.opened.push(url) },
}))
vi.mock('./log', () => ({ log: () => undefined }))

/** A window whose page registers what secureContents gives it */
function fakeWindow(): { window: BrowserWindow; contents: WebContents; open: (url: string) => unknown } {
  let open: (details: { url: string }) => unknown = () => undefined
  const contents = {
    setWindowOpenHandler: (handler: typeof open) => (open = handler),
    on: () => contents,
    getURL: () => 'file:///app/out/renderer/index.html',
  } as unknown as WebContents
  return { window: { webContents: contents } as BrowserWindow, contents, open: url => open({ url }) }
}

function event(sender: WebContents, frame: { url: string; parent: unknown } | null): IpcMainInvokeEvent {
  return { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
}

describe('IPC senders', () => {
  it('only the main frame of a window of the app, showing the app', () => {
    const { window, contents } = fakeWindow()
    const stranger = fakeWindow().contents
    secureContents(window)
    const page = { url: 'file:///app/out/renderer/index.html#/tray', parent: null }
    expect(isTrustedSender(event(contents, page))).toBe(true)
    expect(isTrustedSender(event(stranger, page))).toBe(false)
    expect(isTrustedSender(event(contents, { ...page, parent: {} }))).toBe(false)
    expect(isTrustedSender(event(contents, { url: 'https://evil.com/', parent: null }))).toBe(false)
    expect(isTrustedSender(event(contents, null))).toBe(false)
  })

  it('links of the pages open in the browser only when allowed', async () => {
    const { window, open } = fakeWindow()
    secureContents(window)
    expect(open('https://app.onpage.it/#/x')).toEqual({ action: 'deny' })
    expect(open('http://evil.com/')).toEqual({ action: 'deny' })
    await vi.waitFor(() => expect(electron.opened).toEqual(['https://app.onpage.it/#/x']))
  })
})

describe('permissions', () => {
  it('refuses everything the pages could ask for', () => {
    const handlers: Record<string, (...args: any[]) => unknown> = {}
    const session = new Proxy({} as Session, {
      get: (_target, name: string) => (handler: (...args: any[]) => unknown) => (handlers[name] = handler),
    })
    denyPermissions(session)
    const answers: unknown[] = []
    handlers.setPermissionRequestHandler({}, 'media', (granted: boolean) => answers.push(granted))
    handlers.setDisplayMediaRequestHandler({}, (streams: unknown) => answers.push(streams))
    expect(answers).toEqual([false, null])
    expect(handlers.setPermissionCheckHandler({}, 'clipboard-read')).toBe(false)
    expect(handlers.setDevicePermissionHandler({ deviceType: 'usb' })).toBe(false)
  })
})

describe('debugging switches', () => {
  it('are found however they are written', () => {
    for (const arg of [
      '--inspect',
      '--inspect=9229',
      '--inspect-brk=0',
      '--inspect-port=1',
      '--remote-debugging-port=9222',
      '-remote-debugging-port=9222',
      '--remote-debugging-pipe',
      '/inspect',
    ])
      expect(debugSwitch(['app.exe', arg]), arg).toBe(arg)
  })

  it('leave the switches of the app alone', () => {
    expect(debugSwitch(['app.exe', '--hidden', '--command=sync_all', '--inspector', 'C:\\inspect'])).toBeUndefined()
  })
})
