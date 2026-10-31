<script setup lang="ts">
/** OpFormItem: the label (with its red * when required), the control, the note under it, 4px apart */
defineProps<{ label: string; required?: boolean; note?: string }>()
</script>

<template>
  <div class="flex flex-col gap-xs">
    <div class="flex items-center gap-xs px-2xs text-sm">
      {{ label }}
      <span v-if="required" class="text-danger-fg">*</span>
      <span class="flex-1" />
      <slot name="action" />
    </div>
    <slot />
    <p v-if="note" class="px-2xs text-xs text-secondary">{{ note }}</p>
  </div>
</template>
