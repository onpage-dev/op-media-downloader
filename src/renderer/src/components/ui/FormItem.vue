<script setup lang="ts">
/**
 * OpFormItem: the label (with its red * when required), the control, the note
 * under it, 4px apart. The label is tied to the field and the note describes
 * it: the slot gets the `id` and `describedby` to give the field (and the
 * label's own id, `labelId`, for a button that names itself with it).
 */
import { useId } from 'vue'

const props = defineProps<{ label: string; required?: boolean; note?: string }>()
defineSlots<{
  default(props: { id: string; labelId: string; describedby: string | undefined }): unknown
  action?(): unknown
}>()
const id = useId()
const labelId = `${id}-label`
const noteId = `${id}-note`
</script>

<template>
  <div class="flex flex-col gap-xs">
    <div class="flex items-center gap-xs px-2xs text-sm">
      <label :id="labelId" :for="id">{{ label }}</label>
      <span v-if="required" class="text-danger-fg" aria-hidden="true">*</span>
      <span class="flex-1" />
      <slot name="action" />
    </div>
    <slot :id="id" :label-id="labelId" :describedby="props.note ? noteId : undefined" />
    <p v-if="note" :id="noteId" class="px-2xs text-xs text-secondary">{{ note }}</p>
  </div>
</template>
