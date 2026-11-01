/**
 * Colours of the title bar row, used by main for the native window controls
 * overlay (Windows, Linux) and by the renderer for the row itself. The
 * background is the window's backdrop (the `mica` role of the renderer, light
 * and dark); the symbols are ─ ☐ ✕ as Windows 11 draws them.
 */
export const TITLE_BAR_HEIGHT = 32

export const TITLE_BAR_COLORS = {
  light: { background: '#f2f2f2', symbol: '#1b1b1b' },
  dark: { background: '#161b19', symbol: '#ffffff' },
} as const
