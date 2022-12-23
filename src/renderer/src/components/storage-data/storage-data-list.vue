<script lang="ts" setup>
import { each } from 'lodash'
import { computed, PropType, Ref, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { FolderConfig, StorageData } from '../../../classes/folder-config'
import OpModal from '../op-modal.vue'
import StorageDataForm from './storage-data-form.vue'

const i18n = useI18n()
const emit = defineEmits<{
  (e: 'select', value?: FolderConfig): void
}>()
const props = defineProps({
  storage: {
    type: StorageData,
    required: true,
  },
  selected: {
    type: Object as PropType<FolderConfig>,
  },
})
const form: Ref<Partial<FolderConfig> | undefined> = ref(undefined)
const search_query: Ref<string | undefined> = ref(undefined)

const storage_data = computed(() => props.storage.storage_data)
const filtered_storage_data = computed(() => {
  const res: { [key: string]: FolderConfig } = {}
  each(storage_data.value, (config, key) => {
    if (
      search_query.value &&
      !config.label
        .toLocaleLowerCase()
        .includes(search_query.value.toLocaleLowerCase())
    ) {
      return
    }
    res[key] = config
  })
  return res
})
function openForm(f?: FolderConfig): void {
  form.value = f ?? {}
}
function deleteConfig(f: FolderConfig): void {
  props.storage.delete(`storage_data.${f.api_token}`)
  emit('select', undefined)
}
</script>
<template>
  <!-- Modal -->
  <OpModal v-if="form" @close="form = undefined">
    <StorageDataForm
      :form="form"
      :storage="storage"
      @close="form = undefined"
    />
  </OpModal>
  <div class="full-height-scroll m-unit mt-0 gap-unit" style="min-width: 20rem">
    <!-- Title -->
    <h4 class="flex-row-center-unit">
      <op-icon icon="shapes" class="text-accent" />
      {{ i18n.t('_storage_data.title') }}
    </h4>

    <!-- Search and add btn -->
    <div class="flex-row-center pr-unit-half">
      <op-search v-model="search_query" grow />
      <op-circle-btn
        v-tooltip="i18n.t('_storage_data.add_new_storage')"
        size="10"
        @click="openForm()"
      >
        <op-icon icon="plus" size="lg" />
      </op-circle-btn>
    </div>

    <!-- Items List -->
    <div class="full-height-scroll gap-unit-half pr-unit-half">
      <op-clickable-card
        v-for="(config, key) in filtered_storage_data"
        :key="key"
        class="text-left relative group"
        col
        :active="selected?.api_token == key"
        @click="emit('select', config)"
      >
        <div
          class="flex-row-center absolute right-unit top-unit opacity-0 group-hover:opacity-100 duration-100"
        >
          <op-circle-btn size="8" @click.stop="openForm(config)">
            <op-icon icon="pen-to-square" />
          </op-circle-btn>
          <op-circle-btn
            size="8"
            class="sober-link-danger"
            @click.stop="deleteConfig(config)"
          >
            <op-icon icon="trash-can" />
          </op-circle-btn>
        </div>
        <div>{{ config.label }}</div>
        <div class="text-sm font-mono opacity-50">{{ config.api_token }}</div>
        <div class="text-sm font-mono opacity-50 ellipses">
          {{ config.folder_path }}
        </div>
      </op-clickable-card>
      <div
        v-if="storage_data && !Object.keys(filtered_storage_data).length"
        class="flex-col-center italic opacity-50 py-unit"
      >
        {{ i18n.t('no_items') }}
      </div>
    </div>
  </div>
</template>
