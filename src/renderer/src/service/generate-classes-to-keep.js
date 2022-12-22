const tailwind = require('../../../../tailwind.config.js')

let content_file = ''

const prefix_color_classes = [
  'bg',
  'dark:bg',
  'text',
  'dark:text',
  'border',
  'dark:border',
  'active:bg',
  'dark:active:bg',
  'focus:bg',
  'dark:focus:bg',
  'hover:bg',
  'dark:hover:bg',
]

const number_values = [
  0,
  0.5,
  1,
  1.5,
  2,
  2.5,
  3,
  3.5,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  14,
  16,
  20,
  24,
  28,
  32,
  36,
  40,
  44,
  48,
  52,
  56,
  60,
  64,
  72,
  80,
  96,
  'px',
]

const media_values = ['none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl']
const media_valuesxl = media_values.concat(['3xl', '4xl', '5xl', '6xl', '7xl'])
const screen_value = [
  'screen-sm',
  'screen-md',
  'screen-lg',
  'screen-xl',
  'screen-2xl',
]

const fractions_values = [
  '1/2',
  '1/3',
  '2/3',
  '1/4',
  '2/4',
  '3/4',
  '1/5',
  '2/5',
  '3/5',
  '4/5',
  '1/6',
  '2/6',
  '3/6',
  '4/6',
  '5/6',
]
const fractions_full = fractions_values.concat([
  '1/12',
  '2/12',
  '3/12',
  '4/12',
  '5/12',
  '6/12',
  '7/12',
  '8/12',
  '9/12',
  '10/12',
  '11/12',
])

const generators = [
  {
    prefix: ['border', 'border-t', 'border-r', 'border-b', 'border-l'],
    values: ['px', 0, 2, 4, 8],
    default: true,
  },
  { prefix: ['gap', 'gap-x', 'gap-y'], values: number_values, default: false },
  { prefix: ['text'], values: media_valuesxl, default: false },
  {
    prefix: ['rounded', 'rounded-t', 'rounded-r', 'rounded-b', 'rounded-l'],
    values: media_values.concat(['3xl', 'full']),
    default: true,
  },
  { prefix: ['shadow'], values: media_values.concat(['inner']), default: true },
  { prefix: ['p', 'px', 'py'], values: number_values, default: false },
  {
    prefix: ['w'],
    values: number_values.concat(
      fractions_full.concat(['auto', 'full', 'screen', 'min', 'max']),
    ),
    default: false,
  },
  {
    prefix: ['min-w'],
    values: ['0', 'full', 'min', 'max'],
    default: false,
  },
  {
    prefix: ['max-w'],
    values: media_valuesxl.concat(
      screen_value.concat(['0', 'full', 'min', 'max', 'prose']),
    ),
    default: false,
  },
  {
    prefix: ['h'],
    values: number_values.concat(
      fractions_values.concat(['auto', 'full', 'screen']),
    ),
    default: false,
  },
  {
    prefix: ['max-h'],
    values: number_values.concat(['full', 'screen']),
    default: false,
  },
  {
    prefix: ['min-h'],
    values: ['0', 'full', 'screen'],
    default: false,
  },
  {
    prefix: ['text'],
    values: media_valuesxl.concat(['base', '3xl', '4xl', '5xl']),
    default: false,
  },
  {
    prefix: ['grid-cols'],
    values: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
    default: false,
  },
]

const extra_classes = [
  'focus:outline-none',
  'outline-none',
  'duration-colors-200',
  'cursor-not-allowed',
  'opacity-80',
]

// clases from generators
for (const gen_i in generators) {
  const generator = generators[gen_i]
  for (const prefix_i in generator.prefix) {
    const prefix = generator.prefix[prefix_i]
    if (generator.default) {
      content_file += ' ' + prefix
    }
    for (const val_i in generator.values) {
      content_file += ' ' + prefix + '-' + generator.values[val_i]
    }
  }
}

// extra classes
for (const extra_i in extra_classes) {
  content_file += ' ' + extra_classes[extra_i]
}

// color classes
for (const color in tailwind.theme.colors) {
  const color_obj = tailwind.theme.colors[color]
  const color_classes_default = []
  for (const prefix in prefix_color_classes) {
    color_classes_default.push(prefix_color_classes[prefix] + '-' + color)
  }

  content_file += ' '
  content_file += color_classes_default.join(' ')

  for (const variant in color_obj) {
    if (variant != 'DEFAULT') {
      for (const no_variant in color_classes_default) {
        content_file += ' ' + color_classes_default[no_variant] + '-' + variant
      }
    }
  }
}

const fs = require('fs')
const path = require('path')
fs.writeFileSync(
  path.resolve(__dirname, '../../misc/classes-to-keep.txt'),
  content_file,
)
