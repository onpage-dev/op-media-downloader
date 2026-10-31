<script setup lang="ts">
/** A setting that applies at once (OpToggle): a 40×24 track, the 18px knob sliding in 200ms */
const model = defineModel<boolean>({ required: true })
defineProps<{ label?: string; disabled?: boolean }>()
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="model"
    :aria-label="label"
    :disabled="disabled"
    class="relative h-6 w-10 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-50"
    :class="model ? 'bg-toggle-on' : 'bg-toggle-off'"
    @click="model = !model"
  >
    <span
      class="absolute top-[3px] h-[18px] w-[18px] rounded-full transition-[left] duration-200"
      :class="model ? 'left-[19px] bg-knob-on' : 'left-[3px] bg-knob'"
    />
  </button>
</template>
