<script lang="ts" setup>
const emit = defineEmits(['close'])
</script>
<template>
  <div
    class="animate-fadein-slow overlay z-50 bg-overlay flex-col-center justify-center"
    @click="emit('close')"
  >
    <div
      class="full-height-scroll justify-center p-unit-double gap-unit op-modal"
    >
      <div class="flex-row-center-unit justify-end">
        <op-circle-btn class="sober-link-danger" @click.stop="emit('close')">
          <op-icon icon="x" />
        </op-circle-btn>
      </div>
      <op-overlay-card
        class="flex flex-col relative w-full overflow-auto overflow-x-hidden op-modal-content"
        @click.stop
      >
        <slot />
      </op-overlay-card>
    </div>
  </div>
</template>
