<script lang="ts" setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, PropType } from 'vue'

import { library } from '@fortawesome/fontawesome-svg-core'
import lightIcons from '../../assets/fa-icons-light'
library.add([...lightIcons] as any)

const FA_ICON_TYPES = ['solid', 'regular', 'light', 'thin', 'brand'] as const
type FaIconType = typeof FA_ICON_TYPES[number]
const FA_ICON_CODES = ['fas', 'far', 'fal', 'fat', 'fab'] as const
type FaIconTypeCode = typeof FA_ICON_CODES[number]
type FaIcon = [FaIconTypeCode, string]

const props = defineProps({
  icon: {
    type: String,
    required: true,
  },
  type: {
    type: String as PropType<FaIconType>,
    default: 'light',
  },
  beat: {
    type: Boolean,
  },
  border: {
    type: Boolean,
  },
  fade: {
    type: Boolean,
  },
  fixedWidth: {
    type: Boolean,
  },
  flash: {
    type: Boolean,
  },
  flip: {
    type: String as PropType<'horizontal' | 'vertical' | 'both'>,
  },
  mask: {
    type: [Object, Array, String],
  },
  listItem: {
    type: Boolean,
  },
  pull: {
    type: String as PropType<'right' | 'left'>,
  },
  pulse: {
    type: Boolean,
  },
  rotation: {
    type: [String, Number] as PropType<90 | 180 | 270 | '90' | '180' | '270'>,
  },
  swapOpacity: {
    type: Boolean,
  },
  size: {
    type: String as PropType<
      | 'xs'
      | 'sm'
      | 'lg'
      | '1x'
      | '2x'
      | '3x'
      | '4x'
      | '5x'
      | '6x'
      | '7x'
      | '8x'
      | '9x'
      | '10x'
    >,
  },
  spin: {
    type: Boolean,
  },
  spinPulse: {
    type: Boolean,
  },
  spinReverse: {
    type: Boolean,
  },
  transform: {
    type: [String, Object],
  },
  symbol: {
    type: [Boolean, String],
  },
  title: {
    type: String,
  },
  inverse: {
    type: Boolean,
  },
  bounce: {
    type: Boolean,
  },
  shake: {
    type: Boolean,
  },
  beatFade: {
    type: Boolean,
  },
})
const type_to_code: { [key in FaIconType]: FaIconTypeCode } = {
  solid: 'fas',
  regular: 'far',
  light: 'fal',
  thin: 'fat',
  brand: 'fab',
}

const real_icon = computed((): FaIcon => [type_to_code[props.type], props.icon])
</script>
<template>
  <font-awesome-icon
    :beat="beat"
    :border="border"
    :fade="fade"
    :fixed-width="fixedWidth"
    :flash="flash"
    :flip="flip"
    :icon="real_icon"
    :mask="mask"
    :list-item="listItem"
    :pull="pull"
    :pulse="pulse"
    :rotation="rotation"
    :swap-opacity="swapOpacity"
    :size="size"
    :spin="spin"
    :spin-pulse="spinPulse"
    :spin-reverse="spinReverse"
    :transform="transform"
    :symbol="symbol"
    :title="title"
    :inverse="inverse"
    :bounce="bounce"
    :shake="shake"
    :beat-fade="beatFade"
  />
</template>
