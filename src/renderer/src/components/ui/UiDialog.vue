<script setup lang="ts">
/**
 * OpDialog: the question and what happens (OpModalHeader), what it asks in
 * between, «Annulla» on the left and the answer on the right; 32px around,
 * 40px between its parts. Esc and the veil cancel it.
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { IconDefinition } from '../../lib/icons'
import SpotIcon from './SpotIcon.vue'
import UiButton from './UiButton.vue'

defineProps<{
  tone: 'accent' | 'warning' | 'danger'
  icon: IconDefinition
  title: string
  text: string
  confirm: string
  confirmIcon?: IconDefinition
}>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
const { t } = useI18n()

const onKey = (event: KeyboardEvent): void => {
  if (event.key == 'Escape') {
    event.stopPropagation()
    emit('cancel')
  }
}
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-[var(--veil)] p-lg" @mousedown.self="emit('cancel')">
    <form
      role="alertdialog"
      aria-modal="true"
      class="flex w-[498px] max-w-full flex-col gap-3xl rounded-2xl bg-box p-2xl shadow-window"
      @submit.prevent="emit('confirm')"
    >
      <header class="flex flex-col gap-xl">
        <SpotIcon :icon="icon" :tone="tone" />
        <div class="flex flex-col gap-md">
          <h3 class="font-title text-2xl font-bold">{{ title }}</h3>
          <p class="text-lg text-secondary">{{ text }}</p>
        </div>
      </header>
      <slot />
      <footer class="flex items-center gap-sm">
        <UiButton variant="ghost" @click="emit('cancel')">{{ t('common.cancel') }}</UiButton>
        <span class="flex-1" />
        <UiButton type="submit" :variant="tone == 'danger' ? 'critical' : tone == 'warning' ? 'warning' : 'primary'" :icon="confirmIcon">
          {{ confirm }}
        </UiButton>
      </footer>
    </form>
  </div>
</template>
