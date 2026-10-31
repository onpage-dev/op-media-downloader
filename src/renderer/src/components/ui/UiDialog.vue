<script setup lang="ts">
/**
 * OpDialog: the question and what happens (OpModalHeader), what it asks in
 * between, «Annulla» on the left and the answer on the right; 32px around,
 * 40px between its parts. Esc and the veil cancel it; the focus starts on
 * «Annulla», the answer that changes nothing.
 */
import { useI18n } from 'vue-i18n'
import type { IconDefinition } from '../../lib/icons'
import SpotIcon from './SpotIcon.vue'
import UiButton from './UiButton.vue'
import UiOverlay from './UiOverlay.vue'

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
</script>

<template>
  <UiOverlay
    v-slot="{ titleId, textId }"
    role="alertdialog"
    described
    class="w-[498px] max-w-full rounded-2xl bg-box p-2xl shadow-window"
    @close="emit('cancel')"
  >
    <form class="flex flex-col gap-3xl" @submit.prevent="emit('confirm')">
      <header class="flex flex-col gap-xl">
        <SpotIcon :icon="icon" :tone="tone" />
        <div class="flex flex-col gap-md">
          <h3 :id="titleId" class="font-title text-2xl font-bold">{{ title }}</h3>
          <p :id="textId" class="text-lg text-secondary">{{ text }}</p>
        </div>
      </header>
      <slot />
      <footer class="flex items-center gap-sm">
        <UiButton variant="ghost" data-autofocus @click="emit('cancel')">{{ t('common.cancel') }}</UiButton>
        <span class="flex-1" />
        <UiButton type="submit" :variant="tone == 'danger' ? 'critical' : tone == 'warning' ? 'warning' : 'primary'" :icon="confirmIcon">
          {{ confirm }}
        </UiButton>
      </footer>
    </form>
  </UiOverlay>
</template>
