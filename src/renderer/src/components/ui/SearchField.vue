<script setup lang="ts">
/** OpSearch compact (31px): the magnifier, the words, the ✕ that empties it */
import { ref } from 'vue'
import { faMagnifyingGlass, faXmark } from '../../lib/icons'
import AppIcon from './AppIcon.vue'

const model = defineModel<string>({ required: true })
defineProps<{ placeholder: string; clearLabel: string }>()
const input = ref<HTMLInputElement>()
defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
  <label
    class="flex h-8 min-w-0 items-center gap-sm rounded-md border border-line bg-box px-sm hover:border-accent-fg focus-within:border-accent-fg focus-within:shadow-halo"
  >
    <AppIcon :icon="faMagnifyingGlass" />
    <input
      ref="input"
      v-model="model"
      type="search"
      spellcheck="false"
      :placeholder="placeholder"
      :aria-label="placeholder"
      class="min-w-0 flex-1 bg-transparent text-base placeholder:text-placeholder [&::-webkit-search-cancel-button]:hidden"
      @keydown.esc="model = ''"
    />
    <button
      v-if="model"
      v-tooltip="clearLabel"
      type="button"
      class="flex h-5 w-5 items-center justify-center rounded-sm text-secondary hover:bg-tint"
      @click="model = ''"
    >
      <AppIcon :icon="faXmark" />
    </button>
  </label>
</template>
