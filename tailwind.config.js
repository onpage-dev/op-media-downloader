/**
 * The renderer's tokens: the default theme's roles of the On Page design system
 * as CSS variables (light and dark in src/renderer/src/styles/app.css), the
 * spacing scale, the type scale and the radii.
 */
const role = name => `rgb(var(--c-${name}) / <alpha-value>)`

const roles = [
  'text',
  'secondary',
  'disabled',
  'placeholder',
  'mica',
  'box',
  'box-soft',
  'line',
  'wallpaper',
  'accent',
  'accent-hover',
  'accent-fg',
  'accent-soft',
  'accent-inv',
  'accent-off',
  'success',
  'success-fg',
  'success-soft',
  'info',
  'info-fg',
  'info-soft',
  'warning',
  'warning-fg',
  'warning-soft',
  'warning-inv',
  'danger',
  'danger-fg',
  'danger-soft',
  'danger-inv',
  'neutral',
  'neutral-fg',
  'neutral-soft',
  'toggle-off',
  'toggle-on',
  'knob',
  'knob-on',
]

module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{vue,ts}'],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      ...Object.fromEntries(roles.map(name => [name, role(name)])),
    },
    /** Manrope has Cyrillic, Rethink Sans does not; Chinese comes from the system's font */
    fontFamily: {
      sans: ['Manrope', 'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans CJK SC', 'system-ui', 'sans-serif'],
      title: ['Rethink Sans', 'Manrope', 'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans CJK SC', 'system-ui', 'sans-serif'],
      mono: ['ui-monospace', 'Cascadia Mono', 'Menlo', 'monospace'],
    },
    fontSize: {
      '2xs': ['10px', '12px'],
      xs: ['12px', '1.2'],
      sm: ['14px', '1.2'],
      base: ['14px', '1.5'],
      lg: ['17px', '1.5'],
      xl: ['20px', '1.2'],
      '2xl': ['24px', '1.2'],
      '3xl': ['29px', '1.2'],
    },
    borderRadius: {
      none: '0',
      sm: '4px',
      md: '8px',
      xl: '12px',
      '2xl': '20px',
      full: '9999px',
    },
    extend: {
      /** The design system's spacing scale, next to Tailwind's numeric one */
      spacing: {
        '2xs': '2px',
        xs: '4px',
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
        '2xl': '32px',
        '3xl': '40px',
      },
      boxShadow: {
        popover: '0 3px 8px rgb(0 0 0 / 0.12)',
        window: '0 8px 24px rgb(0 0 0 / 0.18)',
        halo: '0 0 0 3px rgb(var(--c-accent-soft))',
      },
    },
  },
}
