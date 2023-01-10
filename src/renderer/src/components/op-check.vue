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
import { computed, PropType } from 'vue'
const emit = defineEmits(['update:modelValue', 'on', 'off'])
const props = defineProps({
  modelValue: {
    type: Boolean,
  },
  item: {
    type: Object as PropType<any>,
  },
  disabled: {
    type: Boolean,
  },
  radius: {
    type: String,
    default: 'sm',
  },
  color: {
    type: String,
    default: 'dark light',
  },
  on: {
    type: Boolean,
    default: true,
  },
  off: {
    type: Boolean,
    default: false,
  },
  strict: {
    type: Boolean,
  },
  icon: {
    type: String,
    default: 'check',
  },
  only_check: {
    type: Boolean,
  },
})

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
  emit(checked.value ? 'on' : 'off', checked.value ? props.off : props.on)
}
</script>
