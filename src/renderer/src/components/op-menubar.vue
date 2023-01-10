<script lang="ts" setup>
import { StorageService } from '@classes/store'
import { computed } from 'vue'
import OpLogo from './op-logo.vue'

const props = defineProps({
  storage: {
    type: StorageService,
    required: true,
  },
})
const dark_mode = computed(() => props.storage.user_properties.dark_mode)
</script>

<template>
  <div class="flex-col-center justify-center m-unit mb-0 p-unit-double">
    <div class="flex flex-row items-end self-center">
      <OpLogo
        :dark="dark_mode"
        class="w-auto object-contain my-unit flex-shrink-0"
        style="height: 4rem"
      />
    </div>
  </div>
</template>
