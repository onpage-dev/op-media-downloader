/**
 * Colours of the title bar row, used by main for the native window controls
 * overlay (Windows, Linux) and by the renderer for the row itself.
 */
export const TITLE_BAR_HEIGHT = 32

export const TITLE_BAR_COLORS = {
  light: { background: '#f2f2f2', symbol: '#1c1f1e' },
  dark: { background: '#161b19', symbol: '#e3e6e4' },
} as const
