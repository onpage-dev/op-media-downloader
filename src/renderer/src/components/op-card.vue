<template>
  <select
    v-if="element == 'select'"
    ref="focus_element"
    :value="input_value"
    :disabled="!!is_disabled"
    :class="classes_str"
    v-on="input_listeners"
  >
    <option v-if="placeholder" value="" disabled selected hidden>
      {{ placeholder }}
    </option>
    <slot />
  </select>
  <textarea
    v-else-if="element == 'textarea'"
    ref="focus_element"
    :value="input_value"
    :disabled="!!is_disabled"
    :class="classes_str"
    :readonly="readonly"
    :rows="rows"
    :placeholder="placeholder"
    v-on="input_listeners"
  />

  <input
    v-else-if="element == 'input'"
    ref="focus_element"
    :type="type != 'number' ? type : 'text'"
    :size="inputSize"
    :value="input_value"
    :disabled="!!is_disabled"
    :class="classes_str"
    :placeholder="placeholder"
    :maxlength="maxlength"
    :min="min"
    :max="max"
    :step="step"
    :readonly="readonly"
    v-on="input_listeners"
  />
  <component
    :is="element"
    v-else
    ref="focus_element"
    :class="classes_str"
    :type="type"
    :disabled="is_disabled"
    :placeholder="placeholder"
    :href="href || undefined"
    :download="download || undefined"
    v-on="base_listeners"
  >
    <slot />
    <div
      v-if="loading"
      style="background: inherit; border-radius: inherit"
      class="overlay opacity-80 flex-col-center justify-center"
    >
      <OpIcon icon="spinner" spin />
    </div>
  </component>
</template>

<script lang="ts">
import { OpCardColor } from '@classes/color-classes'
import { formattedColor } from '@renderer/service/theme-service'
import { debounce, forEach, isArray, isNumber, isString } from 'lodash'
import { computed, defineComponent, PropType } from 'vue'
import OpIcon from './op-icon.vue'

class Palette {
  public bg!: OpCardColor
  public text!: OpCardColor
  public text_dark!: OpCardColor
  public border!: OpCardColor
  public bg_dark!: OpCardColor
  public border_dark!: OpCardColor
  constructor(config: Palette) {
    Object.assign(this, config)
    if (!this.bg_dark) this.bg_dark = this.bg
    if (!this.border_dark) this.border_dark = this.border
  }
}

const USER_BORDER_SIZE = computed(() => 1)
const USER_SOLID_COLORS = computed(() => false)

export default defineComponent({
  components: { OpIcon },
  props: {
    readonly: {
      type: Boolean,
    },
    maxlength: {
      type: [Number, String],
    },
    inputSize: {
      type: Number,
      default: 20,
    },
    modelValue: {
      type: [Number, String, Object] as PropType<any>,
    },
    undefinedValue: {
      type: [Number, String, Object] as PropType<any>,
    },
    preferUndefined: {
      type: Boolean,
    },
    middle: {
      type: [Boolean, String],
    },
    rows: {
      type: Number,
      default: 5,
    },
    col: {
      type: Boolean,
    },
    expanded: {
      type: Boolean,
    },
    nobg: {
      type: Boolean,
    },
    row: {
      type: Boolean,
    },
    gap: {
      type: [Number, String],
      default: 'gap-unit',
    },
    disabled: {
      type: Boolean,
    },
    loading: {
      type: [Boolean, Number],
    },
    autofocus: {
      type: Boolean,
    },
    type: {
      type: String,
      default: 'card',
    },
    size: {
      type: [Array, String, Number] as PropType<
        string | number | string[] | number[]
      >,
    },
    pad: {
      type: [String, Array, Number],
      default: 'md',
    },
    nopad: {
      type: Boolean,
    },
    color: {
      type: [String, Array] as PropType<string | string[]>,
      default: 'accent',
    },
    acolor: {
      type: [String, Array] as PropType<string | string[]>,
      default: 'accent',
    },
    active: {
      type: Boolean,
    },
    nohover: {
      type: Boolean,
    },
    tcolor: {
      type: [String, Array] as PropType<string | string[]>,
    },
    atcolor: {
      type: [String, Array] as PropType<string | string[]>,
    },
    radius: {
      type: [String, Number],
      default: 'md',
    },
    position: {
      type: String,
      default: 'relative',
    },
    border: {
      type: [Number, Boolean],
      default: true,
    },
    bcolor: {
      type: [String, Array] as PropType<string | string[]>,
    },
    abcolor: {
      type: [String, Array] as PropType<string | string[]>,
    },
    hbcolor: {
      type: [String, Array] as PropType<string | string[]>,
    },
    bactive: {
      type: Boolean,
      default: true,
    },
    shadow: {
      type: String,
    },
    shrink: {
      type: Boolean,
    },
    noshrink: {
      type: Boolean,
    },
    grow: {
      type: Boolean,
    },
    nogrow: {
      type: Boolean,
    },
    wrap: {
      type: Boolean,
    },
    nowrap: {
      type: Boolean,
    },
    animate: {
      type: Boolean,
    },
    placeholder: {
      type: String,
    },
    min: {
      type: [String, Number],
    },
    max: {
      type: [String, Number],
    },
    step: {
      type: [String, Number],
    },
    href: {
      type: String,
    },
    download: {
      type: String,
    },
    textSize: {
      type: [String, Number],
    },
    hover: {
      type: String,
    },
    provide: {
      type: Boolean,
    },
    //Textarea only
    autoResize: {
      type: Boolean,
    },
    debounce: {
      type: [Boolean, Number],
      default: false,
    },
  },
  emits: ['update:modelValue'],
  data() {
    const emit = (value: any): void => this.$emit('update:modelValue', value)
    return {
      emitUpdateValue: this.debounce
        ? debounce(
            emit,
            typeof this.debounce == 'boolean' ? 300 : this.debounce,
          )
        : emit,
      overwrite: {} as any,
    }
  },
  computed: {
    use_solid_colors(): boolean {
      return !!USER_SOLID_COLORS.value
    },

    input_value() {
      if (this.undefinedValue !== undefined && this.modelValue === undefined) {
        return this.undefinedValue
      }
      if (this.type == 'number' && isNaN(this.modelValue as any)) {
        return this.undefinedValue
      }
      return this.modelValue
    },
    is_numeric() {
      return ['number', 'range'].includes(this.type)
    },
    base_listeners() {
      const ret = {} as any
      forEach(this.$attrs, (val, key) => {
        if (key.substring(0, 2) == 'on') {
          ret[key] = val
        }
      })
      return ret
    },
    input_listeners() {
      return Object.assign(this.base_listeners, {
        keypress: (e: KeyboardEvent) => {
          if (!this.is_numeric) return true
          // Replace comma with point
          const elem = e.target as HTMLInputElement
          if (e.key == ',') {
            e.preventDefault()
            const replacement = '.'
            const moveCursorBy = 0
            if (elem.selectionStart || elem.selectionStart === 0) {
              // Determines the start and end of the selection.
              // If no text selected, they are the same and the location of the cursor in the text is returned
              const start = elem.selectionStart
              const end = elem.selectionEnd!
              // Place the replacement on the location of the selection, and remove the data in the selection
              elem.value =
                elem.value.substring(0, start) +
                replacement +
                elem.value.substring(end, elem.value.length)
              // Set the cursor back at the correct location in the text
              elem.selectionStart = start + moveCursorBy + 1
              elem.selectionEnd = start + moveCursorBy + 1
            }
            return false
          } else if (
            e.key?.length == 1 &&
            ![
              '.',
              '-',
              '0',
              '1',
              '2',
              '3',
              '4',
              '5',
              '6',
              '7',
              '8',
              '9',
            ].includes(e.key)
          ) {
            // Disallow invalid characters
            e.preventDefault()
            return false
          }
          return true
        },
        input: ($event: Event) => {
          let value = ($event.target as HTMLInputElement).value as any
          // Autoresize for textarea
          if (this.autoResize && this.element == 'textarea') {
            const target = $event.target! as any
            console.log(target)
            if (!target.style.height) {
              target.setAttribute('style', `height: ${target.scrollHeight}px;`)
            }
            target.style.height = 0
            target.style.height = `${target.scrollHeight}px`
          }
          if (this.is_numeric) {
            value = value === '' ? undefined : Number(value)
            if (!isFinite(value)) {
              value = undefined
            }
            if (value) {
              if (this.min) {
                value = value < this.min ? this.min : value
              }
              if (this.max) {
                value = value > this.max ? this.max : value
              }
            }
          }
          if (this.preferUndefined && this.undefinedValue === value) {
            value = undefined
          }
          if (this.type == 'number' && isNaN(value)) value = undefined
          this.emitUpdateValue(value)
        },
        select: (event: Event) => {
          event.stopPropagation()
        },
      })
    },
    is_disabled() {
      return this.disabled || this.loading
    },
    button() {
      return ['button', 'submit'].includes(this.type)
    },
    is_clickable() {
      return ['button', 'submit'].includes(this.type)
    },
    element() {
      if (this.href) return 'a'
      if (this.type == 'button') return 'button'
      if (this.type == 'submit') return 'button'
      if (this.type == 'card') return 'div'
      if (this.type == 'select') return 'select'
      if (this.type == 'textarea') return 'textarea'
      return 'input'
    },
    is_input(): boolean {
      return ['input', 'textarea', 'select'].includes(this.element)
    },
    palette(): Palette {
      return new Palette({
        bg: this.current_color[0],
        text: this.current_tcolor[0],
        text_dark: this.current_tcolor[1],
        border: this.current_bcolor[0],
        bg_dark: this.current_color[1],
        border_dark: this.current_bcolor[1],
      })
    },
    classes_str(): string {
      return [...this.classes].join(' ')
    },
    current_color(): OpCardColor[] {
      return this.current_color_str.map(c => formattedColor(c))
    },
    current_tcolor(): OpCardColor[] {
      let base = this.active ? this.atcolor : this.tcolor
      if (!base) base = this.current_color.map(c => c.mix('inv'))
      const real = this.getPropColor(base)
      return real.map(c => formattedColor(c))
    },
    current_color_str(): string[] {
      const base_color = this.getPropColor(this.color)
      if (!this.active) return base_color
      let active_color = this.getPropColor(this.acolor)
      active_color = active_color.map(x => x.replace(/^-/, base_color + '-'))
      return active_color
    },
    current_bcolor(): OpCardColor[] {
      return this.current_bcolor_str.map(c => formattedColor(c))
    },
    current_bcolor_str(): string[] {
      let base_color = this.getPropColor(this.bcolor ?? this.color)
      base_color = base_color.map((x, i) =>
        x.replace(/^-/, this.current_color[i].col + '-'),
      )
      if (!this.active) return base_color
      let active_color =
        this.getPropColor(this.abcolor ?? this.acolor) ?? base_color
      active_color = active_color.map((x, i) =>
        x.replace(/^-/, base_color[i] + '-'),
      )
      return active_color
    },
    dark_mode(): boolean {
      const html = document.querySelector('html')!
      return html.classList.contains('dark')
    },
    classes(): Set<string> {
      const ret = new Set<string>()
      const pal = this.palette
      if (this.provide) {
        ret.add('provide-bg')
      }
      ret.add('op-card')
      ret.add('duration-colors-200')
      ret.add('outline-none')
      ret.add('focus:outline-none')
      if (this.textSize) {
        ret.add(`text-${this.textSize}`)
      }
      if (this.shrink) {
        ret.add('flex-shrink')
      } else if (this.noshrink) {
        ret.add('flex-shrink-0')
      }
      if (this.grow) {
        ret.add('flex-grow')
      } else if (this.nogrow) {
        ret.add('grow-0')
      }
      if (this.wrap) {
        ret.add('flex-wrap')
      } else if (this.nowrap) {
        ret.add('flex-nowrap')
      }
      // Border
      {
        const border_size =
          this.border === true ? USER_BORDER_SIZE.value : this.border
        if (this.border && border_size) {
          ret.add(border_size > 1 ? `border-${border_size} ` : 'border ')
          ret.add(
            `border-${pal.border.mix()} dark:border-${pal.border_dark.mix()}`,
          )
          if (this.is_clickable) {
            ret.add(`hover:border-${pal.border.mix(1)}`)
            ret.add(`dark:hover:border-${pal.border_dark.mix(1)}`)
          }
          if (this.is_input) {
            ret.add(
              `focus:bg-${pal.bg.mix(-1)} dark:focus:bg-${pal.bg_dark.mix(-1)}`,
            )
            ret.add('focus:border-accent dark:focus:border-accent')
          }
        }
      }
      if (this.is_disabled) {
        ret.add('cursor-not-allowed')
      }
      // Background color
      if (!this.nobg) {
        ret.add(`bg-${pal.bg.mix()}`)
        ret.add(`dark:bg-${pal.bg_dark.mix()}`)
        if (this.active) {
          if (!this.use_solid_colors) {
            ret.add('text-dark')
            ret.add('dark:text-light')
          } else {
            ret.add(`text-${pal.text.mix()}`)
            ret.add(`dark:text-${pal.text_dark.mix()}`)
          }
        } else {
          ret.add(`text-${pal.text.mix()}`)
          ret.add(`dark:text-${pal.text_dark.mix()}`)
        }
        if (this.active && !this.use_solid_colors) {
          if (!this.use_solid_colors) {
            ret.add('op-active-card-backdrop')
          }
        }
      }
      if (this.type == 'select' && !this.modelValue) {
        ret.add('opacity-5')
      }
      if (this.is_clickable) {
        if (this.is_disabled) {
          // TODO
        } else {
          ret.add('cursor-pointer')
          ret.add('duration-colors-100')
          if (!this.nohover) {
            ret.add(
              `hover:bg-${pal.bg.mix(1)} dark:hover:bg-${pal.bg_dark.mix(-1)}`,
            )
            ret.add(
              `hover:text-${pal.bg.mix(
                1,
              )}-inv dark:hover:text-${pal.bg_dark.mix(-1)}-inv`,
            )
          }
          ret.add(
            `active:bg-${pal.bg.mix(2)} dark:active:bg-${pal.bg_dark.mix(-2)}`,
          )
          ret.add(
            `active:text-${pal.bg.mix(
              2,
            )}-inv dark:active:text-${pal.bg_dark.mix(-2)}-inv`,
          )
        }
      }
      if (this.row) {
        ret.add('flex flex-row')
      } else if (this.col) {
        ret.add('flex flex-col')
      }
      if (this.middle) {
        if (!this.row && !this.col) ret.add('flex-col')
        if (this.middle == 'items') {
          ret.add('items-center')
        } else if (this.middle == 'justify') {
          ret.add('justify-center')
        } else {
          ret.add('items-center justify-center')
        }
      }
      if (isNumber(this.gap)) {
        ret.add(`gap-${this.gap}`)
      }
      if (isString(this.gap)) {
        let gap = this.gap
        if (!gap.startsWith('gap-')) gap = 'gap-' + gap
        ret.add(gap)
      }
      if (this.overwrite.radius ?? this.radius) {
        ret.add(`rounded-${this.overwrite.radius ?? this.radius}`)
      }
      if (this.shadow) {
        ret.add(`shadow-${this.shadow}`)
      }
      if (this.position) {
        ret.add(`${this.position}`)
      }
      if (this.expanded) {
        ret.add('flex-grow')
      }
      // Size
      if (isArray(this.size)) {
        ret.add(`w-${this.size[0]} h-${this.size[1]}`)
      } else if (this.size) {
        ret.add(`w-${this.size} h-${this.size}`)
      }
      if (!this.nopad && this.pad) {
        if (isNumber(this.pad)) {
          ret.add(`p-${this.pad}`)
        } else if (isArray(this.pad)) {
          if (this.pad[0] != null) {
            ret.add(`py-${this.pad[0]}`)
          }
          if (this.pad[1] != null) {
            ret.add(`px-${this.pad[1]}`)
          }
        } else if (isString(this.pad)) {
          let padding_preset = {
            sm: 'p-unit text-sm',
            compact: 'py-unit-half px-unit',
            md: 'p-unit',
            lg: 'p-3 text-xl',
            custom: '',
          } as any
          if (this.button) {
            padding_preset = {
              sm: 'p-unit text-sm',
              compact: 'py-unit-half px-unit',
              md: 'py-unit px-unit-double',
              lg: 'py-3 px-10 text-xl',
              custom: '',
            } as any
          }
          if (this.element == 'input') {
            padding_preset = {
              sm: 'py-unit-half px-unit-double text-sm',
              compact: 'py-unit-half px-unit',
              md: 'py-unit px-unit-double',
              lg: 'py-3 px-10 text-xl',
              custom: '',
            } as any
          }
          ret.add(padding_preset[this.pad] ?? this.pad)
        }
      }
      return ret
    },
    html_element(): HTMLElement | undefined {
      return this.$refs.focus_element as any
    },
  },
  mounted() {
    if (this.autofocus) {
      this.focus()
    }
    if (this.animate && this.html_element) {
      this.html_element.addEventListener('mouseenter', this.addAnimationClass)
      this.html_element.addEventListener(
        'mouseleave',
        this.removeAnimationClass,
      )
    }
  },
  beforeUnmount() {
    if (this.html_element) {
      this.html_element.removeEventListener(
        'mouseenter',
        this.addAnimationClass,
      )
      this.html_element.removeEventListener(
        'mouseleave',
        this.removeAnimationClass,
      )
    }
  },
  methods: {
    getPropColor(col: string | string[]): string[] {
      col = isArray(col) ? col : col.split(' ')
      if (!col[1]) col[1] = col[0]
      return col
    },
    addAnimationClass() {
      if (!this.html_element) return
      this.html_element.classList.add('animate__animated')
      this.html_element.classList.add('animate__tada')
    },
    removeAnimationClass() {
      if (!this.html_element) return
      this.html_element.classList.remove('animate__animated')
      this.html_element.classList.remove('animate__tada')
    },
    focus() {
      setTimeout(() => {
        if (this.html_element) {
          this.html_element.focus()
        }
      }, 20)
    },
    blur() {
      setTimeout(() => {
        if (this.html_element && this.html_element.blur) {
          this.html_element.blur()
        }
      }, 20)
    },
  },
})
</script>

<style lang="scss">
.op-card {
  &[type='range'] {
    -webkit-appearance: none;
    appearance: none;
    padding: 0;
    margin-top: 1 rem;
    margin-bottom: 1 rem;
    outline: none;
    height: 0.5rem;

    &::-webkit-slider-thumb {
      -webkit-appearance: none; /* Override default look */
      appearance: none;
      border-radius: 99px;
      width: 1.3rem; /* Set a specific slider handle width */
      height: 1.3rem; /* Slider handle height */
      cursor: pointer; /* Cursor on hover */
      @apply shadow-sm bg-darker;
    }
  }
}
</style>
