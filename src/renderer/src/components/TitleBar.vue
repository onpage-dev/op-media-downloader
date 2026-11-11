<script setup lang="ts">
/**
 * The title row, 32px, that drags the window (double click maximizes): the
 * app's icon and name on the backdrop. On Windows and Linux the window has no
 * frame of its own: ─ ☐ ✕ are drawn here on the right, as Windows 11 draws
 * them. On macOS the traffic lights sit on the left (the window's overlay
 * title bar): 80px stay free.
 */
import { useI18n } from 'vue-i18n'
import { TITLE_BAR_HEIGHT } from '@shared/window-chrome'
import { closeWindow, minimizeWindow, platform, toggleMaximizeWindow } from '../store'
import AppLogo from './ui/AppLogo.vue'

defineProps<{ title?: string }>()
const { t } = useI18n()
const mac = platform() == 'darwin'
</script>

<template>
  <header
    data-tauri-drag-region
    class="drag-region flex shrink-0 items-center gap-sm"
    :style="{ height: `${TITLE_BAR_HEIGHT}px`, paddingLeft: mac ? '80px' : '12px' }"
  >
    <AppLogo class="pointer-events-none h-4 w-4" />
    <span data-tauri-drag-region class="min-w-0 flex-1 truncate text-xs">{{ title ?? t('app.name') }}</span>
    <div v-if="!mac" class="no-drag flex h-full self-stretch">
      <button
        type="button"
        class="window-control hover:bg-tint"
        :aria-label="t('window.minimize')"
        :title="t('window.minimize')"
        @click="minimizeWindow"
      >
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" /></svg>
      </button>
      <button
        type="button"
        class="window-control hover:bg-tint"
        :aria-label="t('window.maximize')"
        :title="t('window.maximize')"
        @click="toggleMaximizeWindow"
      >
        <svg viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" rx="1" /></svg>
      </button>
      <button
        type="button"
        class="window-control window-close"
        :aria-label="t('common.close')"
        :title="t('common.close')"
        @click="closeWindow"
      >
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" /></svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.window-control {
  display: flex;
  width: 46px;
  align-items: center;
  justify-content: center;
  color: var(--color-text);
}
.window-control svg {
  width: 10px;
  height: 10px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1;
}
.window-control:focus-visible {
  outline: 2px solid var(--color-accent-fg);
  outline-offset: -2px;
}
/* Windows 11's close: red with a white cross */
.window-close:hover {
  background-color: #c42b1c;
  color: #fff;
}
</style>
