<script lang="ts" setup>
import { computed, Ref, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { FolderConfig, StorageData } from '../../../classes/folder-config'
import OpModal from '../op-modal.vue'
import StorageDataForm from './storage-data-form.vue'

const i18n = useI18n()
const props = defineProps({
  storage: {
    type: StorageData,
    required: true,
  },
})
const form: Ref<Partial<FolderConfig> | undefined> = ref(undefined)

const storage_data = computed(() => props.storage.storage_data)

function openForm(f?: FolderConfig): void {
  form.value = f ?? {}
}
</script>
<template>
  <OpModal v-if="form" @close="form = undefined">
    <StorageDataForm
      :form="form"
      :storage="storage"
      @close="form = undefined"
    />
  </OpModal>
  <div class="full-height-scroll m-unit-half gap-unit">
    <h4 class="flex-row-center-unit">
      <op-icon icon="shapes" class="text-accent" />
      {{ i18n.t('_storage_data.title') }}
      <op-circle-btn
        v-tooltip="i18n.t('_storage_data.add_new_storage')"
        size="8"
        @click="openForm()"
      >
        <op-icon icon="plus" />
      </op-circle-btn>
    </h4>
    <div class="flex-row-center pr-unit-half">
      <op-search grow />
    </div>
    <div class="full-height-scroll pr-unit-half">
      <op-clickable-card
        v-for="(config, key) in storage_data"
        :key="key"
        class="text-left"
        col
      >
        <div>{{ config.label }}</div>
        <div class="text-sm font-mono opacity-50">{{ config.api_token }}</div>
        <div class="text-sm font-mono opacity-50 ellipses">
          {{ config.folder_path }}
        </div>
      </op-clickable-card>
      <div
        v-if="storage_data && !Object.keys(storage_data).length"
        class="flex-col-center italic opacity-50 py-unit"
      >
        {{ i18n.t('no_items') }}
      </div>
    </div>
  </div>
</template>
