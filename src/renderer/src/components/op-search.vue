<script lang="ts" setup>
import { computed, PropType } from 'vue'
import { useI18n } from 'vue-i18n'

const i18n = useI18n()
defineEmits(['update:modelValue'])
const props = defineProps({
  modelValue: {
    type: [Object, String, Number] as PropType<any>,
  },
  icon: {
    type: String,
    default: 'search',
  },
  autofocus: {
    type: Boolean,
  },
  placeholder: {
    type: String,
  },
  color: {
    type: String,
  },
  action: {
    type: Function as PropType<(payload: Event) => void>,
  },
  radius: {
    type: String,
    default: 'full',
  },
  border: {
    type: [Boolean, Number],
    default: true,
  },
  bcolor: {
    type: [String, Array] as PropType<string | string[]>,
  },
  hbcolor: {
    type: [String, Array] as PropType<string | string[]>,
  },
  compact: {
    type: Boolean,
  },
  pad: {
    type: String,
  },
  grow: {
    type: Boolean,
  },
})
const get_placeholder = computed((): string => {
  if (props.placeholder) {
    return props.placeholder
  }
  return i18n.t('search_placeholder')
})
</script>
<template>
  <form
    class="flex-row-center relative"
    :class="{ 'flex-grow': grow }"
    @submit.prevent="action"
  >
    <div class="absolute left-3.5 z-10">
      <op-icon :icon="icon" size="sm" />
    </div>

    <op-input
      ref="input"
      :color="color"
      :bcolor="bcolor"
      :hbcolor="hbcolor"
      :placeholder="get_placeholder"
      :radius="radius"
      class="w-full pl-9"
      :model-value="modelValue"
      :autofocus="autofocus"
      :pad="compact ? 'compact' : pad"
      @update:model-value="$emit('update:modelValue', $event)"
    />
    <input type="submit" class="hidden" />
  </form>
</template>
