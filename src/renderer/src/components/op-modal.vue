<script lang="ts" setup>
const emit = defineEmits(['close'])
</script>
<template>
  <div
    class="animate-fadein-slow absolute h-full w-full z-50 bg-darkwallpaper bg-opacity-50 flex-col-center justify-center"
    @click="emit('close')"
  >
    <div class="flex flex-col gap-unit op-modal">
      <div class="flex-row-center-unit justify-end">
        <op-circle-btn class="sober-link-danger" @click.stop="emit('close')">
          <op-icon icon="x" />
        </op-circle-btn>
      </div>
      <op-overlay-card class="op-modal-content" @click.stop>
        <slot />
      </op-overlay-card>
    </div>
  </div>
</template>
