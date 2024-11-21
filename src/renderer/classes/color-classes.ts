const COLOR_LUMINOSITY = [
  'std',
  'inv',
  'l1',
  'l2',
  'l3',
  'l4',
  'l5',
  'd1',
  'd2',
  'd3',
  'd4',
  'd5',
] as const
export type ColorLuminosity = (typeof COLOR_LUMINOSITY)[number]
export type RgbColor = [number, number, number]
export interface PaletteColor {
  label?: string
  variants: {
    [key in ColorLuminosity]: RgbColor
  }
  created_at?: string
  updated_at?: string
}
export type PaletteID = number
export interface Palette {
  id: PaletteID
  label: string
  colors: PaletteColors
  created_at: string
  updated_at?: string
}
export const PALETTE_COLOR_IDENTIFIERS = [
  'wallpaper',
  'box',
  'text',
  'accent',
  'button',
  'cta',
  'info',
  'success',
  'warning',
  'danger',
  'custom0',
  'custom1',
  'custom2',
  'custom3',
  'custom4',
  'custom5',
  'custom6',
  'custom7',
  'custom8',
  'custom9',
  'custom10',
  'custom11',
  'custom12',
  'custom13',
  'custom14',
  'custom15',
  'custom16',
  'custom17',
  'custom18',
  'custom19',
] as const
export type PaletteColorIdentifier = (typeof PALETTE_COLOR_IDENTIFIERS)[number]
export type PaletteColors = {
  [key in PaletteColorIdentifier]?: PaletteColor
}

export interface OpCardColor {
  col: any
  lum: number
  inv: boolean
  mix(diff?: number | string): string
}
