<script setup lang="ts">
/** A text field (op-input): box, its line, 8px in; the accent's line and halo when focused, red when invalid */
import { ref } from 'vue'

const model = defineModel<string>({ required: true })
withDefaults(
  defineProps<{
    placeholder?: string
    type?: 'text' | 'password' | 'number'
    invalid?: boolean
    compact?: boolean
    mono?: boolean
  }>(),
  { type: 'text' },
)
const input = ref<HTMLInputElement>()
defineExpose({ focus: () => input.value?.focus(), select: () => input.value?.select() })
</script>

<template>
  <input
    ref="input"
    v-model="model"
    :type="type"
    :placeholder="placeholder"
    :aria-invalid="invalid || undefined"
    spellcheck="false"
    class="w-full min-w-0 rounded-md border bg-box px-sm text-base text-text placeholder:text-placeholder hover:border-accent-fg focus:border-accent-fg focus:shadow-halo"
    :class="[invalid ? 'border-danger' : 'border-line', compact ? 'h-8' : 'h-control', mono ? 'font-mono text-sm' : '']"
  />
</template>
