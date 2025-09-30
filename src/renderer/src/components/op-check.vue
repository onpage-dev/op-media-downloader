<template>
  <div
    :class="classes"
    class="select-none"
    @click="toggle()"
    @keydown.enter.prevent.stop="toggle()"
    @keydown.space.prevent.stop="toggle()"
  >
    <op-btn
      :color="checked ? color : 'transparent'"
      :border="true"
      :bcolor="color"
      :disabled="disabled"
      :radius="radius"
      pad="custom"
      class="w-4 h-4 text-center text-sm flex-shrink-0"
      middle
    >
      <op-icon v-if="checked" :icon="icon" />
    </op-btn>
    <div>
      <slot />
    </div>
  </div>
</template>

<script lang="ts" setup>
import { isArray } from 'lodash'
import { computed } from 'vue'
const emit = defineEmits<{
  'update:modelValue': [val?: boolean]
  on: [val?: boolean]
  off: [val?: boolean]
}>()
const props = withDefaults(
  defineProps<{
    modelValue?: boolean
    item?: any
    disabled?: boolean
    radius?: string
    color?: string
    on?: boolean
    off?: boolean
    strict?: boolean
    icon?: string
    only_check?: boolean
  }>(),
  {
    radius: 'sm',
    color: 'dark light',
    on: true,
    off: false,
    icon: 'check',
  },
)

const classes = computed(() => {
  let classes = ''

  classes += props.disabled ? ' cursor-disabled ' : ' cursor-pointer '
  classes += props.only_check ? '' : 'flex-row-center-unit'
  return classes
})
const checked = computed(() => {
  if (isArray(props.modelValue)) {
    return props.modelValue.includes(props.item)
  } else {
    return props.strict
      ? props.modelValue === props.on
      : props.modelValue == props.on
  }
})

function toggle(): void {
  if (props.disabled) return

  emit('update:modelValue', checked.value ? props.off : props.on)
  checked.value ? emit('on', props.off) : emit('off', props.on)
}
</script>
