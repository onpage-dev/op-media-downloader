<script setup lang="ts">
/**
 * The title row, 32px, that drags the window: the app's icon and name on the
 * backdrop. On Windows and Linux the system draws ─ ☐ ✕ on the right
 * (titleBarOverlay): the row stops where `titlebar-area-width` ends. On macOS
 * the traffic lights sit on the left (hiddenInset): 80px stay free.
 */
import { useI18n } from 'vue-i18n'
import { TITLE_BAR_HEIGHT } from '@shared/window-chrome'
import icon from '../../assets/app-icon.png'
import { platform } from '../store'

defineProps<{ title?: string }>()
const { t } = useI18n()
const mac = platform() == 'darwin'
</script>

<template>
  <header
    class="drag-region flex shrink-0 items-center gap-sm"
    :style="{
      height: `${TITLE_BAR_HEIGHT}px`,
      marginLeft: 'env(titlebar-area-x, 0)',
      width: 'env(titlebar-area-width, 100%)',
      paddingLeft: mac ? '80px' : '12px',
    }"
  >
    <img :src="icon" class="h-4 w-4" alt="" />
    <span class="truncate text-xs">{{ title ?? t('app.name') }}</span>
  </header>
</template>
