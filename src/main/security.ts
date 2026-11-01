/**
 * What the pages of the app may do: no permission of the web (camera,
 * screen, devices, notifications…), no window or navigation of their own,
 * links only to On Page and GitHub, IPC only from the app's own windows. The
 * installed app does not run with a debugger attached.
 */
import { app, BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, Session, shell, WebContents } from 'electron'
import inspector from 'inspector'
import { log } from './log'
import { externalUrl } from './validate'

/** The pages of the main window and the tray panel */
const trusted = new WeakSet<WebContents>()

/** Every window of the app: links go to the browser, no navigation away, IPC answered */
export function secureContents(window: BrowserWindow): void {
  trusted.add(window.webContents)
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url).catch(() => log('warn', `Link not opened: ${url.slice(0, 200)}`))
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (url.split('#')[0] != current.split('#')[0]) event.preventDefault()
  })
}

/** The browser opens On Page and GitHub over https only */
export async function openExternal(value: unknown): Promise<void> {
  const url = externalUrl(value)
  if (!url) throw new Error('invalid_url')
  await shell.openExternal(url)
}

/** Only the main frame of a window of the app, showing the app, talks to main */
export function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  try {
    const frame = event.senderFrame
    return !!frame && !frame.parent && trusted.has(event.sender) && isAppPage(frame.url)
  } catch {
    /** A frame that went away meanwhile */
    return false
  }
}

/** The renderer of the app: its files, or the development server */
function isAppPage(address: string): boolean {
  try {
    const url = new URL(address)
    const dev_server = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
    return dev_server ? url.origin == new URL(dev_server).origin : url.protocol == 'file:'
  } catch {
    return false
  }
}

/** The pages ask for nothing: every permission, device and screen capture is refused */
export function denyPermissions(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
  session.setDisplayMediaRequestHandler((_request, callback) => callback(null))
}

/** Node's inspector and Chromium's remote debugging, however the switch is written (`--`, `-`, `/` on Windows) */
const DEBUG_SWITCH = /^(?:--?|\/)(?:inspect(?:-[\w-]+)?|remote-debugging-[\w-]+)(?:=|$)/i
const DEBUG_SWITCH_NAMES = ['inspect', 'inspect-brk', 'inspect-port', 'remote-debugging-port', 'remote-debugging-pipe']

/** The debugging switch the app was started with, if any */
export function debugSwitch(argv: readonly string[]): string | undefined {
  return argv.find(arg => DEBUG_SWITCH.test(arg))
}

/** What would let another program drive the installed app: a debugging switch or a live inspector */
export function debuggingRequested(): string | undefined {
  return (
    debugSwitch(process.argv) ??
    DEBUG_SWITCH_NAMES.find(name => app.commandLine.hasSwitch(name)) ??
    (inspector.url() ? 'inspector' : undefined)
  )
}
