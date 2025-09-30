<template>
  <div>
    <label
      class="flex-row-center-unit"
      :class="disabled ? 'cursor-not-allowed opacity-80 ' : 'pointer'"
    >
      <op-clickable-card
        class="h-6 w-10"
        radius="full"
        nopad
        @click="toggle()"
        @keydown.enter.prevent.stop="toggle()"
        @keydown.space.prevent.stop="toggle()"
      >
        <input class="hidden" type="checkbox" :checked="checked" />
        <op-solid-card
          :color="checked ? acolor ?? 'dark light' : color ?? 'darker dark-0'"
          radius="full"
          nopad
          position="absolute"
          class="top-0 bottom-0 my-auto h-4 w-4 duration-200"
          :class="{
            'left-1': !checked,
            'left-4': checked,
          }"
        />
      </op-clickable-card>
      <slot />
    </label>
  </div>
</template>
<script lang="ts" setup>
import { cloneDeep, isArray, isObject } from 'lodash'
import { computed } from 'vue'

const emit = defineEmits<{
  'update:modelValue': [val?: object | boolean | any[] | string | number]
}>()
const props = withDefaults(
  defineProps<{
    modelValue?: object | boolean | any[] | string | number
    item?: object | boolean | any[] | string | number
    disabled?: boolean
    on?: object | boolean | string | number
    off?: object | boolean | string | number
    boolean?: boolean
    color?: string | string[]
    acolor?: string | string[]
    scolor?: string | string[]
    strict?: boolean
  }>(),
  {
    on: true,
    off: false,
    scolor: 'white',
  },
)
const checked = computed(() => {
  if (isArray(props.modelValue)) {
    return props.modelValue.includes(props.item)
  } else {
    return props.strict
      ? props.modelValue === props.on
      : looseCheck(props.modelValue, props.on)
  }
})
function looseCheck(a: any, b: any): boolean {
  if (isObject(a) || isObject(b)) {
    return JSON.stringify(a) == JSON.stringify(b)
  }
  return a == b
}
function toggle(): void {
  if (props.disabled) return
  if (isArray(props.modelValue)) {
    const i = props.modelValue.indexOf(props.item)
    const local_model_value = cloneDeep(props.modelValue)
    if (i >= 0) {
      local_model_value.splice(i, 1)
    } else {
      local_model_value.push(props.item)
    }
    emit('update:modelValue', local_model_value)
  } else {
    emit('update:modelValue', checked.value ? props.off : props.on)
  }
}
</script>
