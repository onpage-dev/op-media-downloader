const colors = getColors()

function getColors() {
  const res = {}
  ;[
    'accent',
    'wallpaper',
    'darkerwallpaper',
    'darkwallpaper',
    'darkerdarkwallpaper',
    'box',
    'dbox',

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

    'inherit',
  ].forEach(name => {
    if (!res[name]) res[name] = {}

    res[name].DEFAULT = x => generateColor(`${name}`, x)
    res[name].inv = x => generateColor(`${name}-inv`, x)

    for (let i = 0; i <= 10; i++) {
      res[name][i] = x => generateColor(`${name}-${i}`, x)
    }
  })
  return res
}
function generateColor(name, { opacityVariable, opacityValue }) {
  if (opacityValue !== undefined) {
    return `rgba(var(--color-${name}), ${opacityValue})`
  }
  if (opacityVariable !== undefined) {
    return `rgba(var(--color-${name}), var(${opacityVariable}, 1))`
  }
  return `rgb(var(--color-${name}))`
}

module.exports = {
  content: [
    './src/renderer/misc/classes-to-keep.txt',
    './src/renderer/**/*.vue',
    './src/renderer/**/*.html',
  ],
  darkMode: 'class',
  theme: {
    screens: {
      sm: '640px',
      md: '768px',
      lg: '1024px',
      xl: '1280px',
      '2xl': '1536px',
    },
    colors,
    extend: {
      fontFamily: {
        mono: ['FiraCode'],
        sans: ['neue', 'ui-sans-serif', 'system-ui'],
        serif: ['neue', 'ui-serif', 'Georgia'],
      },
      spacing: {
        md: '43rem',
        'unit-double': '1.2rem',
        unit: '.6rem',
        'unit-half': '.3rem',
        18: '4.5rem',
      },
    },
  },
}
