<script lang="ts" setup>
import { StorageService } from '@classes/store'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import OpToggle from './op-toggle.vue'

const i18n = useI18n()
const props = defineProps({
  storage: {
    type: StorageService,
    required: true,
  },
})
const dark_mode = computed(() => props.storage.user_properties.dark_mode)
function toggleDarkMode(): void {
  props.storage.set('user_properties.dark_mode', !dark_mode.value)
}
</script>
<template>
  <div class="full-height-scroll gap-unit-double modal-size-w-sm">
    <h4>{{ i18n.t('user_settings') }}</h4>
    <div class="full-height-scroll pr-unit-half">
      <OpToggle :model-value="dark_mode" @update:model-value="toggleDarkMode()">
        <span> {{ i18n.t('dark_mode') }}</span>
      </OpToggle>
    </div>
  </div>
</template>
