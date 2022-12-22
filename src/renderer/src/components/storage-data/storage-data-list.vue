<script lang="ts" setup>
import { StorageData } from '../../../classes/folder-config'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const i18n = useI18n()
const props = defineProps({
  storageData: {
    type: StorageData,
    required: true,
  },
})

const config_services = computed(() => props.storageData.config_services)
</script>
<template>
  <div class="full-height-scroll gap-unit">
    <h4 class="flex-row-center-unit">
      <op-icon icon="shapes" class="text-accent" />
      {{ i18n.t('_storage_data.title') }}
      <op-circle-btn
        v-tooltip="i18n.t('_storage_data.add_new_storage')"
        size="8"
      >
        <op-icon icon="plus" />
      </op-circle-btn>
    </h4>
    <div class="flex-row-center pr-unit-half">
      <op-search grow />
    </div>
    <div class="full-height-scroll pr-unit-half">
      <op-clickable-card
        v-for="config in config_services"
        :key="config.api_token"
        col
      >
        <div class="flex-row-center">
          {{ i18n.t('_storage_data.label') }}: {{ config.label }}
        </div>
      </op-clickable-card>
      <div
        v-if="!config_services.length"
        class="flex-col-center italic opacity-50 py-unit"
      >
        {{ i18n.t('no_items') }}
      </div>
    </div>
  </div>
</template>
