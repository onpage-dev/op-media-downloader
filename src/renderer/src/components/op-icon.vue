<script lang="ts" setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed } from 'vue'

import { library } from '@fortawesome/fontawesome-svg-core'
import regularIcons from '../../assets/fa-icons'
library.add([...regularIcons] as any)

const FA_ICON_TYPES = ['solid', 'regular', 'light', 'thin', 'brand'] as const
type FaIconType = (typeof FA_ICON_TYPES)[number]
const FA_ICON_CODES = ['fas', 'far', 'fal', 'fat', 'fab'] as const
type FaIconTypeCode = (typeof FA_ICON_CODES)[number]
type FaIcon = [FaIconTypeCode, string]

const props = withDefaults(
  defineProps<{
    icon: string
    type?: FaIconType
    beat?: boolean
    border?: boolean
    fade?: boolean
    fixed_width?: boolean
    flash?: boolean
    flip?: 'horizontal' | 'vertical' | 'both'
    list_item?: boolean
    pull?: 'right' | 'left'
    pulse?: boolean
    rotation?: 90 | 180 | 270 | '90' | '180' | '270'
    swap_opacity?: boolean
    size?:
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
    spin?: boolean
    spin_pulse?: boolean
    spin_reverse?: boolean
    transform?: string | object
    symbol?: boolean | string
    title?: string
    inverse?: boolean
    bounce?: boolean
    shake?: boolean
    beat_fade?: boolean
  }>(),
  {
    type: 'solid',
  },
)
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
    :fixed-width="fixed_width"
    :flash="flash"
    :flip="flip"
    :icon="real_icon"
    :list-item="list_item"
    :pull="pull"
    :pulse="pulse"
    :rotation="rotation"
    :swap-opacity="swap_opacity"
    :size="size"
    :spin="spin"
    :spin-pulse="spin_pulse"
    :spin-reverse="spin_reverse"
    :transform="transform"
    :symbol="symbol"
    :title="title"
    :inverse="inverse"
    :bounce="bounce"
    :shake="shake"
    :beat-fade="beat_fade"
  />
</template>
