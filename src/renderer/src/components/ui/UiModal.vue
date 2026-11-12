<script setup lang="ts">
/**
 * OpModal: the card on the veil (UiOverlay), 20px corners, 14px in and 50px on
 * top under its ✕; the title (h3) and its line, the content that scrolls
 * between a still head and footer. Esc, the veil and the ✕ close it.
 */
import { useI18n } from 'vue-i18n'
import { faXmark } from '../../lib/icons'
import IconButton from './IconButton.vue'
import UiOverlay from './UiOverlay.vue'

withDefaults(defineProps<{ title: string; subtitle?: string; size?: 's' | 'm' }>(), { size: 's' })
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
</script>

<template>
  <UiOverlay
    v-slot="{ titleId }"
    class="relative flex max-h-[92vh] max-w-full flex-col gap-lg rounded-2xl bg-box px-[14px] pb-[14px] pt-[50px] shadow-window"
    :style="{ width: `${(size == 's' ? 434 : 682) + 28}px` }"
    @close="emit('close')"
  >
    <IconButton
      :icon="faXmark"
      :label="t('common.close')"
      :size="36"
      class="absolute right-sm-md top-sm-md"
      @click="emit('close')"
    />
    <header class="flex flex-col gap-xs">
      <h3 :id="titleId" class="font-title text-2xl font-bold">{{ title }}</h3>
      <p v-if="subtitle" class="text-secondary">{{ subtitle }}</p>
    </header>
    <!-- Room for the fields' halos all round; the one below also takes the fraction of a pixel a last line of
         12px text (14.4px high) sticks out, which alone made a scrollbar for nothing -->
    <div class="-mx-[14px] -my-xs min-h-0 flex-1 overflow-auto px-[14px] py-xs"><slot /></div>
    <footer v-if="$slots.footer" class="flex items-center gap-sm"><slot name="footer" /></footer>
  </UiOverlay>
</template>
