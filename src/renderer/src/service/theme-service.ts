import { OpCardColor } from '@classes/color-classes'
import Color from 'color'
import { each, isNumber, isString } from 'lodash'

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
export type THEME_COLOR = (typeof colors)[number]
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

export function formattedColor(string: string): OpCardColor {
  const exploded = string.split('-')
  const col = exploded[0]
  const inv = exploded[1] == 'inv'
  let lum = Number(exploded[1] || 5)
  if (isNaN(lum)) lum = 5
  return {
    col,
    lum,
    inv,
    mix(diff?: number | 'inv' | 'mix'): string {
      if (isString(diff)) {
        return this.col + '-' + diff
      } else if (isNumber(diff)) {
        return this.col + '-' + (this.lum + diff)
      } else if (this.inv) {
        return this.col + '-inv'
      } else {
        return this.col + '-' + this.lum
      }
    },
  }
}

export const themes: Theme[] = [
  {
    name: 'modern',
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
]
