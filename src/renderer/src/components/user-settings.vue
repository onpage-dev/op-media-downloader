<script lang="ts" setup>
import { StorageService } from '@classes/store'
import { computed, onBeforeMount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import OpToggle from './op-toggle.vue'

const i18n = useI18n()
const props = defineProps({
  storage: {
    type: StorageService,
    required: true,
  },
})
const local_simultaneous_downloads = ref(1)
const simultaneous_downloads = computed(
  () => props.storage.user_properties.simultaneous_downloads,
)
const dark_mode = computed(() => props.storage.user_properties.dark_mode)
function toggleDarkMode(): void {
  props.storage.set('user_properties.dark_mode', !dark_mode.value)
}
function setSimultaneousDownloads(): void {
  props.storage.set(
    'user_properties.simultaneous_downloads',
    local_simultaneous_downloads.value ?? 1,
  )
}
onBeforeMount(() => {
  local_simultaneous_downloads.value = simultaneous_downloads.value ?? 1
})
</script>
<template>
  <div class="full-height-scroll gap-unit-double modal-size-w-sm">
    <h4>{{ i18n.t('user_settings') }}</h4>
    <div class="full-height-scroll gap-unit-double pr-unit-half">
      <OpToggle :model-value="dark_mode" @update:model-value="toggleDarkMode()">
        <span> {{ i18n.t('dark_mode') }}</span>
      </OpToggle>

      <div class="flex flex-col">
        <span>
          {{ $t('simultaneous_downloads') }}
          <span class="text-sm opacity-50"> ({{ $t('min_1') }}) </span>
        </span>
        <div class="flex-row-center-unit">
          <op-input
            v-model="local_simultaneous_downloads"
            type="number"
            :min="1"
            grow
          />
          <op-btn
            :color="
              local_simultaneous_downloads !== simultaneous_downloads
                ? undefined
                : 'inherit'
            "
            :disabled="local_simultaneous_downloads == simultaneous_downloads"
            @click="setSimultaneousDownloads()"
          >
            <op-icon icon="save" /> {{ $t('save') }}
          </op-btn>
        </div>
      </div>
    </div>
  </div>
</template>
