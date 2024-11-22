<script lang="ts" setup>
const emit = defineEmits<{
  close: []
}>()
</script>
<template>
  <div class="overlay bg-overlay z-50 flex-col" @click="emit('close')">
    <div class="op-modal full-height-scroll h-full p-unit-double">
      <op-overlay-card class="op-modal-content m-auto" col @click.stop>
        <op-circle-btn
          class="top-0 right-0 group"
          position="absolute"
          radius="md"
          size="9"
          @click.stop="emit('close')"
        >
          <op-icon icon="x" class="group-hover:text-red duration-100" />
        </op-circle-btn>

        <slot />
      </op-overlay-card>
    </div>
  </div>
</template>
<style lang="scss">
/** Modal Fade */
.modal-fade-enter-from,
.modal-fade-leave-to {
  @apply opacity-0;
}
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.3s ease;
}
.modal-fade-enter-to,
.modal-fade-leave-from {
  @apply opacity-100;
}
</style>
