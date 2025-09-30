<script lang="ts" setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
defineEmits<{
  'update:modelValue': [val?: string]
}>()
const props = withDefaults(
  defineProps<{
    modelValue?: string
    icon?: string
    autofocus?: boolean
    placeholder?: string
    color?: string
    action?: (payload: Event) => void
    radius?: string
    border?: boolean | number
    bcolor?: string | string[]
    hbcolor?: string | string[]
    compact?: boolean
    pad?: string
    grow?: boolean
  }>(),
  {
    icon: 'search',
    radius: 'full',
    border: true,
  },
)
const get_placeholder = computed((): string => {
  if (props.placeholder) {
    return props.placeholder
  }
  return t('search_placeholder')
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
