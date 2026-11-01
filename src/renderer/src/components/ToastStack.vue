<script setup lang="ts">
/**
 * The toasts (what failed, in words), centred under the title row, the newest
 * on top; they slide in and fade out. Out of the page's tree, over the modals:
 * a failure behind the settings or the wizard is still seen and can be closed.
 */
import { app, dismiss } from '../store'
import UiToast from './ui/UiToast.vue'
</script>

<template>
  <Teleport to="body">
    <TransitionGroup
      tag="div"
      data-toasts
      class="pointer-events-none fixed inset-x-0 top-3xl z-[60] flex flex-col-reverse items-center gap-sm px-lg"
      enter-from-class="opacity-0 -translate-y-sm"
      enter-active-class="transition duration-200 ease-out"
      leave-to-class="opacity-0"
      leave-active-class="transition duration-100 ease-in"
      move-class="transition-transform duration-200"
    >
      <UiToast
        v-for="toast in app.toasts"
        :key="toast.id"
        class="no-drag pointer-events-auto"
        :tone="toast.tone"
        :text="toast.text"
        @close="dismiss(toast.id)"
      />
    </TransitionGroup>
  </Teleport>
</template>
