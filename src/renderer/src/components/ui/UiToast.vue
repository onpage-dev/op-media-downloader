<script setup lang="ts">
/**
 * OpToast: the tone's soft, a 1.5px border in the tone, the tone's icon, the
 * words in the page's colour and the ✕. It goes by itself after a few seconds,
 * but not while the pointer or the focus is on it.
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { faXmark } from '../../lib/icons'
import { TONE_FG, TONE_ICON, TONE_LINE, TONE_SOFT } from '../../lib/status-view'
import type { ToastTone } from '../../store'
import AppIcon from './AppIcon.vue'
import IconButton from './IconButton.vue'

defineProps<{ tone: ToastTone; text: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const SHOWN_MS = 8000
let timer: ReturnType<typeof setTimeout> | undefined
const wait = (): void => {
  clearTimeout(timer)
  timer = setTimeout(() => emit('close'), SHOWN_MS)
}
const hold = (): void => clearTimeout(timer)
onMounted(wait)
onBeforeUnmount(hold)
</script>

<template>
  <div
    class="flex max-w-[420px] items-center gap-lg rounded-md border-[1.5px] px-lg py-md text-sm shadow-popover"
    :class="[TONE_SOFT[tone], TONE_LINE[tone]]"
    :role="tone == 'danger' ? 'alert' : 'status'"
    @mouseenter="hold"
    @mouseleave="wait"
    @focusin="hold"
    @focusout="wait"
  >
    <span class="flex min-w-0 items-center gap-sm">
      <AppIcon :icon="TONE_ICON[tone]" class="text-lg" :class="TONE_FG[tone]" />
      <span class="min-w-0">{{ text }}</span>
    </span>
    <IconButton :icon="faXmark" :label="t('common.close')" :size="24" class="ml-auto" @click="emit('close')" />
  </div>
</template>
