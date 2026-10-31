<script setup lang="ts" generic="T extends string">
/**
 * One choice among a few (OpTabGroup variant="button"): joined buttons, the
 * chosen one in the accent's soft. A radio group: one stop for Tab, the arrows
 * move the choice. Name it with `aria-labelledby` (or `aria-label`).
 */
const model = defineModel<T>({ required: true })
const props = defineProps<{ options: { value: T; label: string }[] }>()

/** The stop for Tab: the chosen option, or the first when none is */
const stop = (value: T): boolean => (props.options.some(o => o.value == model.value) ? value == model.value : value == props.options[0]?.value)

const STEPS: Partial<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
function onKey(event: KeyboardEvent): void {
  const step = STEPS[event.key]
  if (!step) return
  event.preventDefault()
  const count = props.options.length
  const at = props.options.findIndex(o => o.value == model.value)
  const next = (Math.max(at, 0) + step + count) % count
  model.value = props.options[next].value
  ;(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role=radio]')[next]?.focus()
}
</script>

<template>
  <div class="inline-flex" role="radiogroup" @keydown="onKey">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="radio"
      :aria-checked="model == option.value"
      :tabindex="stop(option.value) ? 0 : -1"
      class="-ml-px h-control border px-md text-sm font-medium first:ml-0 first:rounded-l-md last:rounded-r-md"
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
