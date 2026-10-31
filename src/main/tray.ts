/**
 * Icon in the notification area (menu bar on macOS) with a dot for the state,
 * a native menu on right click and the panel (`#/tray`) on left click. On
 * Linux the menu is the icon's context menu: most desktops report no clicks.
 */
import { BrowserWindow, Menu, nativeImage, NativeImage, screen, Tray } from 'electron'
import icon_path from '../../build/icon.png?asset'
import { StatusTone } from '../shared/status'

/** Dot colours of the state vocabulary; `undefined` = no dot (up to date) */
const DOT_COLORS: Partial<Record<StatusTone, [number, number, number]>> = {
  accent: [31, 138, 91],
  info: [47, 111, 214],
  warning: [232, 147, 12],
  danger: [217, 54, 54],
  neutral: [138, 143, 141],
}

const PANEL_WIDTH = 380
const PANEL_HEIGHT = 440

export interface TrayActions {
  open: () => void
  syncAll: () => void
  quit: () => void
  /** Loads `#/tray` in the panel window */
  loadPanel: (window: BrowserWindow) => void
  preload: string
  labels: () => { open: string; sync_all: string; quit: string }
}

export class TrayController {
  private tray?: Tray
  private panel?: BrowserWindow
  private icons = new Map<string, NativeImage>()
  private tone?: StatusTone
  private tooltip = ''

  constructor(private actions: TrayActions) {}

  get enabled(): boolean {
    return !!this.tray
  }

  enable(): void {
    if (this.tray) return
    this.tray = new Tray(this.icon(this.tone))
    this.tray.setToolTip(this.tooltip)
    this.tray.on('click', () => this.togglePanel())
    this.tray.on('right-click', () => this.tray?.popUpContextMenu(this.menu()))
    this.refreshMenu()
  }

  /** The labels changed (another language) */
  refreshMenu(): void {
    if (process.platform == 'linux') this.tray?.setContextMenu(this.menu())
  }

  disable(): void {
    this.panel?.destroy()
    this.panel = undefined
    this.tray?.destroy()
    this.tray = undefined
  }

  update(tone: StatusTone | undefined, tooltip: string): void {
    if (tone != this.tone) {
      this.tone = tone
      this.tray?.setImage(this.icon(tone))
    }
    if (tooltip != this.tooltip) {
      this.tooltip = tooltip
      this.tray?.setToolTip(tooltip)
    }
  }

  /** Every window that shows projects gets the same events */
  get panelWindow(): BrowserWindow | undefined {
    return this.panel && !this.panel.isDestroyed() ? this.panel : undefined
  }

  hidePanel(): void {
    this.panelWindow?.hide()
  }

  private togglePanel(): void {
    const panel = this.ensurePanel()
    if (panel.isVisible()) return panel.hide()
    this.position(panel)
    panel.show()
    panel.focus()
  }

  private ensurePanel(): BrowserWindow {
    if (this.panelWindow) return this.panelWindow
    const panel = new BrowserWindow({
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: { preload: this.actions.preload, sandbox: true, spellcheck: false },
    })
    panel.on('blur', () => panel.hide())
    this.actions.loadPanel(panel)
    this.panel = panel
    return panel
  }

  private position(panel: BrowserWindow): void {
    const bounds = this.tray?.getBounds()
    const point = bounds
      ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      : screen.getCursorScreenPoint()
    const { workArea } = screen.getDisplayNearestPoint(point)
    const below = point.y < workArea.y + workArea.height / 2
    let x = Math.round(point.x - PANEL_WIDTH / 2)
    let y = below
      ? Math.round((bounds ? bounds.y + bounds.height : point.y) + 6)
      : Math.round((bounds ? bounds.y : point.y) - PANEL_HEIGHT - 6)
    x = Math.min(Math.max(x, workArea.x + 8), workArea.x + workArea.width - PANEL_WIDTH - 8)
    y = Math.min(Math.max(y, workArea.y + 8), workArea.y + workArea.height - PANEL_HEIGHT - 8)
    panel.setPosition(x, y, false)
  }

  private menu(): Menu {
    const labels = this.actions.labels()
    return Menu.buildFromTemplate([
      { label: labels.open, click: () => this.actions.open() },
      { label: labels.sync_all, click: () => this.actions.syncAll() },
      { type: 'separator' },
      { label: labels.quit, click: () => this.actions.quit() },
    ])
  }

  /** The app icon at 16pt (32px) with a dot for the state in the corner */
  private icon(tone: StatusTone | undefined): NativeImage {
    const key = tone ?? 'none'
    const cached = this.icons.get(key)
    if (cached) return cached
    const size = 32
    const base = nativeImage.createFromPath(icon_path).resize({ width: size, height: size, quality: 'best' })
    const color = tone ? DOT_COLORS[tone] : undefined
    const image = color ? withDot(base, size, color) : base
    const result = nativeImage.createEmpty()
    result.addRepresentation({ scaleFactor: 2, width: size, height: size, buffer: image.toPNG() })
    this.icons.set(key, result)
    return result
  }
}

/** Draws an anti-aliased dot with a light ring on a BGRA bitmap */
function withDot(base: NativeImage, size: number, [r, g, b]: [number, number, number]): NativeImage {
  const bitmap = Buffer.from(base.toBitmap())
  const cx = size - 8
  const cy = size - 8
  const radius = 6.5
  const ring = 8
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      const i = (y * size + x) * 4
      if (distance <= radius + 0.5) {
        const a = Math.min(1, radius + 0.5 - distance)
        blend(bitmap, i, [b, g, r], a)
      } else if (distance <= ring + 0.5) {
        const a = Math.min(1, ring + 0.5 - distance)
        blend(bitmap, i, [255, 255, 255], a)
      }
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size })
}

function blend(bitmap: Buffer, i: number, [c0, c1, c2]: [number, number, number], alpha: number): void {
  const keep = 1 - alpha
  bitmap[i] = Math.round(c0 * alpha + bitmap[i] * keep)
  bitmap[i + 1] = Math.round(c1 * alpha + bitmap[i + 1] * keep)
  bitmap[i + 2] = Math.round(c2 * alpha + bitmap[i + 2] * keep)
  bitmap[i + 3] = Math.round(255 * alpha + bitmap[i + 3] * keep)
}
