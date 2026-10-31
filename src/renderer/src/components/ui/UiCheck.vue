<script setup lang="ts">
/** A yes or no saved later (OpCheck): the 16px box, accent with its check when on; the label toggles it too and names it */
import { useId } from 'vue'
import { faCheck } from '../../lib/icons'
import AppIcon from './AppIcon.vue'

const model = defineModel<boolean>({ required: true })
defineProps<{ disabled?: boolean }>()
const id = useId()
</script>

<template>
  <label class="inline-flex items-center gap-sm" :class="disabled ? 'text-disabled' : ''">
    <button
      type="button"
      role="checkbox"
      :aria-checked="model"
      :aria-labelledby="id"
      :disabled="disabled"
      class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-xs border text-2xs"
      :class="model ? 'border-accent bg-accent text-accent-inv' : 'border-secondary bg-box'"
      @click="model = !model"
    >
      <AppIcon v-if="model" :icon="faCheck" />
    </button>
    <!-- The label passes a click on the words to the box -->
    <span :id="id"><slot /></span>
  </label>
</template>
