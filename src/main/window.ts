/**
 * The main window: integrated title bar (native controls drawn by the OS on
 * Windows and Linux, traffic lights on macOS), bounds remembered between
 * launches, links opened in the browser, no navigation away from the app, a
 * page that crashed loaded again.
 */
import { app, BrowserWindow, nativeTheme, Rectangle, screen } from 'electron'
import path from 'path'
import icon_path from '../../build/icon.png?asset'
import { TITLE_BAR_COLORS, TITLE_BAR_HEIGHT } from '../shared/window-chrome'
import { log } from './log'
import { secureContents } from './security'
import { AppStore, WindowState } from './store'

const DEFAULT_SIZE = { width: 1100, height: 720 }
export const MIN_SIZE = { width: 860, height: 560 }

/** A page that crashed is loaded again, at most MAX_RELOADS times in RELOAD_WINDOW_MS */
const MAX_RELOADS = 3
const RELOAD_WINDOW_MS = 2 * 60_000

export function preloadPath(): string {
  return path.join(__dirname, '../preload/index.js')
}

/** Loads the renderer, optionally at a route (`tray`) */
export function loadRenderer(window: BrowserWindow, route?: string): void {
  const hash = route ? `#/${route}` : ''
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}${hash}`)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: route ? `/${route}` : undefined })
  }
}

/**
 * The page of the window crashed or was killed: it is loaded again, unless it
 * keeps crashing (then it stays as it is, and the log says so)
 */
export function reloadOnCrash(window: BrowserWindow, route?: string): void {
  const name = route ?? 'main window'
  let reloads: number[] = []
  window.webContents.on('render-process-gone', (_event, details) => {
    log('error', `Renderer of the ${name} gone: ${details.reason} (exit code ${details.exitCode})`)
    if (details.reason == 'clean-exit' || window.isDestroyed()) return
    const now = Date.now()
    reloads = reloads.filter(at => now - at < RELOAD_WINDOW_MS)
    if (reloads.length >= MAX_RELOADS) {
      log(
        'error',
        `Renderer of the ${name} crashed ${reloads.length + 1} times in ${RELOAD_WINDOW_MS / 60_000} minutes: not loaded again`,
      )
      return
    }
    reloads.push(now)
    loadRenderer(window, route)
  })
}

function chromeColors(): { background: string; symbol: string } {
  return nativeTheme.shouldUseDarkColors ? TITLE_BAR_COLORS.dark : TITLE_BAR_COLORS.light
}

export function createMainWindow(store: AppStore): BrowserWindow {
  const state = restoredState(store.windowState)
  const is_mac = process.platform == 'darwin'
  const colors = chromeColors()

  const window = new BrowserWindow({
    ...state.bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: 'On Page Media Downloader',
    backgroundColor: colors.background,
    titleBarStyle: is_mac ? 'hiddenInset' : 'hidden',
    ...(is_mac
      ? { trafficLightPosition: { x: 12, y: (TITLE_BAR_HEIGHT - 14) / 2 } }
      : { titleBarOverlay: { color: colors.background, symbolColor: colors.symbol, height: TITLE_BAR_HEIGHT } }),
    ...(process.platform == 'linux' ? { icon: icon_path } : {}),
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  if (state.maximized) window.maximize()

  const onTheme = (): void => {
    if (window.isDestroyed()) return
    const next = chromeColors()
    window.setBackgroundColor(next.background)
    if (!is_mac)
      window.setTitleBarOverlay({ color: next.background, symbolColor: next.symbol, height: TITLE_BAR_HEIGHT })
  }
  nativeTheme.on('updated', onTheme)
  window.on('closed', () => nativeTheme.off('updated', onTheme))

  let save_timer: NodeJS.Timeout | undefined
  const saveState = (): void => {
    clearTimeout(save_timer)
    save_timer = setTimeout(() => {
      if (window.isDestroyed()) return
      const bounds = window.getNormalBounds()
      store.windowState = { ...bounds, maximized: window.isMaximized() }
    }, 400)
  }
  for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const) {
    window.on(event as 'resize', saveState)
  }

  secureContents(window)
  reloadOnCrash(window)
  if (!app.isPackaged) {
    /** Development: F12 opens the developer tools (there is no menu on Windows) */
    window.webContents.on('before-input-event', (_event, input) => {
      if (input.type == 'keyDown' && input.key == 'F12') window.webContents.toggleDevTools()
    })
  }
  loadRenderer(window)
  return window
}

/** Saved bounds only when they are still on a connected display */
function restoredState(saved: WindowState | undefined): {
  bounds: Partial<Rectangle> & { width: number; height: number }
  maximized: boolean
} {
  const fallback = { bounds: { ...DEFAULT_SIZE }, maximized: false }
  if (!saved) return fallback
  const width = Math.max(MIN_SIZE.width, saved.width)
  const height = Math.max(MIN_SIZE.height, saved.height)
  if (saved.x === undefined || saved.y === undefined) return { bounds: { width, height }, maximized: saved.maximized }
  const visible = screen.getAllDisplays().some(({ workArea }) => {
    const overlap_x = Math.min(saved.x! + width, workArea.x + workArea.width) - Math.max(saved.x!, workArea.x)
    const overlap_y = Math.min(saved.y! + height, workArea.y + workArea.height) - Math.max(saved.y!, workArea.y)
    return overlap_x > 100 && overlap_y > 50
  })
  return visible
    ? { bounds: { x: saved.x, y: saved.y, width, height }, maximized: saved.maximized }
    : { bounds: { width, height }, maximized: saved.maximized }
}
