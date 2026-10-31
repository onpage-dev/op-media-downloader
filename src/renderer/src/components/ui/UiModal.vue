<script setup lang="ts">
/**
 * OpModal: the card on the veil, 20px corners, 14px in and 50px on top under
 * its ✕; the title (h3) and its line, the content that scrolls between a
 * still head and footer. Esc, the veil and the ✕ close it.
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { faXmark } from '../../lib/icons'
import IconButton from './IconButton.vue'

withDefaults(defineProps<{ title: string; subtitle?: string; size?: 's' | 'm' }>(), { size: 's' })
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const onKey = (event: KeyboardEvent): void => {
  if (event.key == 'Escape') {
    event.stopPropagation()
    emit('close')
  }
}
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-[var(--veil)] p-lg" @mousedown.self="emit('close')">
    <section
      role="dialog"
      aria-modal="true"
      class="relative flex max-h-[92vh] max-w-full flex-col gap-lg rounded-2xl bg-box px-[14px] pb-[14px] pt-[50px] shadow-window"
      :style="{ width: `${(size == 's' ? 434 : 682) + 28}px` }"
    >
      <IconButton :icon="faXmark" :label="t('common.close')" :size="36" class="absolute right-[10px] top-[10px]" @click="emit('close')" />
      <header class="flex flex-col gap-xs">
        <h3 class="font-title text-2xl font-bold">{{ title }}</h3>
        <p v-if="subtitle" class="text-secondary">{{ subtitle }}</p>
      </header>
      <div class="-mx-[14px] min-h-0 flex-1 overflow-auto px-[14px]"><slot /></div>
      <footer v-if="$slots.footer" class="flex items-center gap-sm"><slot name="footer" /></footer>
    </section>
  </div>
</template>
