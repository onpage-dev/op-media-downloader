import Color from 'color'
import { each, isString } from 'lodash'

const colors = [
  'accent',
  'wallpaper',
  'darkerwallpaper',
  'darkwallpaper',
  'darkerdarkwallpaper',
  'white',
  'light',
  'grey',
  'darker',
  'dark',
  'black',

  'brand',
  'info',
  'success',
  'warning',
  'danger',

  'yellow',
  'blue',
  'red',
  'orange',
  'pink',
  'green',
  'box',
  'dbox',
] as const
export type THEME_COLOR = typeof colors[number]
interface RawThemeColors {
  [key: string]: string
}
type ThemeColors = Record<THEME_COLOR, string | ExtendedThemeColor>
interface ExtendedThemeColor {
  lightest: string
  normal: string
  darkest: string
}
type ExtendedThemeColors = Record<THEME_COLOR, RawThemeColors>
export interface Theme {
  name: string
  label: string
  // solid_cards?: boolean
  // dark_panels?: boolean
  colors: ExtendedThemeColors
}

export class ThemeService {
  static generateColors(theme_colors: ThemeColors): ExtendedThemeColors {
    const colors: Partial<ExtendedThemeColors> = {}

    each(theme_colors, (info, name) => {
      ;(colors as any)[name] = colorToCssVars(name, info)
    })

    return colors as ExtendedThemeColors
  }

  public static isLight(col: Color): boolean {
    return col.luminosity() > 0.45
  }
}

export function colorToCssVars(
  name: string,
  color_info: string | ExtendedThemeColor,
): RawThemeColors {
  const force_inv = ['grey', 'darker'].includes(name)
    ? Color('#000000')
    : ['green', 'brand', 'blue', 'red'].includes(name)
    ? Color('#ffffff')
    : null

  const ret: any = {}
  if (isString(color_info)) {
    color_info = stringToColorVariants(color_info)
  }

  const normal = Color(color_info.normal)
  const lightest = Color(color_info.lightest)
  const darkest = Color(color_info.darkest)

  ret.DEFAULT = colorToRgb(normal)
  ret.active = colorToRgb(normal.mix(Color('#ffffff'), 0.8))
  ret.activedark = colorToRgb(normal.mix(Color('#3c3c47'), 0.9))
  ret.inv = colorToRgb(
    force_inv || Color(ThemeService.isLight(normal) ? '#151515' : '#efefef'),
  )

  for (let i = 0; i <= 5; i++) {
    const percent = i / 5
    const variant = lightest.mix(normal, percent)
    ret[i] = colorToRgb(variant)
  }
  for (let i = 1; i <= 5; i++) {
    const percent = i / 5
    const variant = normal.mix(darkest, percent)
    ret[5 + i] = colorToRgb(variant)
  }
  return ret
}

export function stringToColorVariants(
  color_info: string | ExtendedThemeColor,
): ExtendedThemeColor {
  if (!isString(color_info)) return color_info
  const col = Color(color_info)
  const lum = col.luminosity()
  const lum_max = (1 - Math.abs(lum)) * 0.8 * Math.sign(lum - 0.8)
  const lum_min = (1 - Math.abs(lum)) * 0.8 * Math.sign(lum - 0.8)
  return {
    normal: color_info,
    lightest: col.lighten(lum_max).hex(),
    darkest: col.darken(lum_min).hex(),
  }
}

function colorToRgb(color: Color): string {
  return [color.red(), color.green(), color.blue()].join(',')
}

export const themes: Theme[] = [
  {
    name: 'default',
    label: 'Originale',
    colors: ThemeService.generateColors({
      white: {
        lightest: '#ffffff',
        normal: '#ffffff',
        darkest: '#E0E6EC',
      },
      light: '#f4f5f7',
      grey: '#ededed',
      wallpaper: '#f1f2f6',
      darkerwallpaper: '#e9ebf1',
      darkwallpaper: '#3c3c47',
      darkerdarkwallpaper: '#393944',
      box: {
        lightest: '#ffffff',
        normal: '#ffffff',
        darkest: '#d1d4d6',
      },
      dbox: '#4c4c57',
      darker: '#d8d8d8',
      dark: '#3c3c47',
      black: '#0a0a0a',
      brand: '#00cc78',
      accent: '#00cc78',
      info: '#209cee',
      success: '#23d160',
      warning: '#ff8800',
      danger: '#ff0000',
      yellow: '#FFD420',
      blue: '#17b1fb',
      red: '#bf616a',
      orange: '#FFAE4B',
      pink: '#fed5e5',
      green: '#00cc78',
    }),
  },
  {
    name: 'andrian',
    label: 'Modern',
    colors: ThemeService.generateColors({
      white: {
        lightest: '#ffffff',
        normal: '#FCFCFC',
        darkest: '#e3e3e3',
      },
      light: '#f4f5f7',
      grey: '#e6e6e6',
      wallpaper: '#f3f3f2',
      darkerwallpaper: '#eeeeec',
      darkwallpaper: '#222222',
      darkerdarkwallpaper: '#1f1f1f',
      box: {
        lightest: '#ffffff',
        normal: '#fcfcfc',
        darkest: '#d6d6d6',
      },
      dbox: '#333333',
      darker: '#9a9b9c',
      dark: '#333333',
      black: '#161616',
      brand: '#00cc78',
      accent: '#00cc78',
      info: '#51afed',
      success: '#66d18c',
      warning: '#ffa640',
      danger: '#ff4d4d',
      yellow: '#ffdb4d',
      blue: '#2da9e3',
      red: '#e35b5b',
      orange: '#ffad5c',
      pink: '#f7bae1',
      green: '#46d89b',
    }),
  },
  {
    name: 'giacomo',
    label: 'Colori caldi',
    colors: ThemeService.generateColors({
      white: {
        lightest: '#ffffff',
        normal: '#ffffff',
        darkest: '#E0E6EC',
      },
      wallpaper: '#f5f5f5',
      darkerwallpaper: '#f0f0f0',
      darkwallpaper: {
        lightest: '#4a4a55',
        normal: '#3c3c47',
        darkest: '#2f2f37',
      },
      darkerdarkwallpaper: '#393944',
      box: {
        lightest: '#ffffff',
        normal: '#ffffff',
        darkest: '#d1d4d6',
      },
      dbox: '#4c4c57',
      light: '#f5f5f5',
      grey: '#ededed',
      darker: '#d8d8d8',
      dark: '#313237',
      black: '#0a0a0a',
      brand: '#00cc78',
      accent: '#00cc78',
      info: '#209cee',
      success: '#23d160',
      warning: '#ff8800',
      danger: '#ff0000',
      yellow: '#FFD420',
      blue: '#17b1fb',
      red: '#bf616a',
      orange: '#FFAE4B',
      pink: '#fed5e5',
      green: '#00cc78',
    }),
  },
  {
    name: 'nord',
    label: 'Nord',
    colors: ThemeService.generateColors({
      white: {
        lightest: '#ffffff',
        normal: '#ffffff',
        darkest: '#E5E9F0',
      },
      light: '#ECEFF4',
      grey: '#D8DEE9',
      wallpaper: '#f2f3F5',
      darkerwallpaper: '#eeeff2',
      darkwallpaper: '#363c4c',
      darkerdarkwallpaper: '#3a4152',
      box: {
        lightest: '#ffffff',
        normal: '#ffffff',
        darkest: '#D8DEE9',
      },
      dbox: '#4C566A',
      darker: '#D8DEE9',
      dark: '#3B4252',
      black: '#060606',
      brand: '#00cc78',
      accent: '#00cc78',
      info: '#A3BE8C',
      success: '#23d160',
      warning: '#ff8800',
      danger: '#ff0000',
      yellow: '#FFD420',
      blue: '#17b1fb',
      red: '#BF616A',
      orange: '#D08770',
      pink: '#B48EAD',
      green: '#A3BE8C',
    }),
  },
]
