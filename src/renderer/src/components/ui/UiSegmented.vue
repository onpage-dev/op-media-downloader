<script setup lang="ts" generic="T extends string">
/** One choice among a few (OpTabGroup variant="button"): joined buttons, the chosen one in the accent's soft */
const model = defineModel<T>({ required: true })
defineProps<{ options: { value: T; label: string }[] }>()
</script>

<template>
  <div class="inline-flex" role="radiogroup">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="radio"
      :aria-checked="model == option.value"
      class="-ml-px h-[39px] border px-md text-sm font-medium first:ml-0 first:rounded-l-md last:rounded-r-md"
      :class="
        model == option.value
          ? 'relative z-[1] border-accent-fg bg-accent-soft text-accent-fg'
          : 'border-line bg-box text-text hover:bg-box-soft'
      "
      @click="model = option.value"
    >
      {{ option.label }}
    </button>
  </div>
</template>
