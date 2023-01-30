<script lang="ts" setup>
import { FolderConfig, FolderConfigJson } from '@classes/folder-config'
import { StorageService } from '@classes/store'
import { v4 as uuidv4 } from 'uuid'

import { computed, PropType, Ref, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import OpCheck from '../op-check.vue'
import OpModal from '../op-modal.vue'
import UserSettings from '../user-settings.vue'
import StorageServiceForm from './storage-data-form.vue'
import StorageServiceItem from './storage-data-item.vue'

const i18n = useI18n()
const emit = defineEmits<{
  (e: 'select', value?: FolderConfigJson): void
}>()
const props = defineProps({
  storage: {
    type: StorageService,
    required: true,
  },
  selected: {
    type: Object as PropType<FolderConfigJson>,
  },
})
const show_user_settings = ref(false)
const deleting: Ref<FolderConfigJson | undefined> = ref(undefined)
const aborting: Ref<FolderConfig | undefined> = ref(undefined)
const delete_downloaded = ref(false)
const form: Ref<FolderConfigJson | undefined> = ref(undefined)
const search_query: Ref<string | undefined> = ref(undefined)

const filtered_configs = computed(() => {
  let ret = [...props.storage.configs.values()]
  const q = search_query.value
  if (q) {
    ret = ret.filter(x => x.label.toLocaleLowerCase().includes(q))
  }
  return ret
})
const configs_with_duplicate_images = computed(() => {
  return Array.from(props.storage.configs.values()).filter(
    config => config.duplicated_images.size && !config.loaders.size,
  )
})

function openForm(f?: FolderConfigJson): void {
  form.value = f ?? {
    api_token: '',
    folder_path: '',
    id: uuidv4(),
    label: '',
  }
}
function clearDelete(): void {
  deleting.value = undefined
  delete_downloaded.value = false
}
function deleteConfig(): void {
  if (!deleting.value) return
  props.storage.delete(`storage_data.${deleting.value.id}`)
  if (delete_downloaded.value) {
    window.electron.ipcRenderer.send('deleteFolder', deleting.value.folder_path)
  }
  clearDelete()
  emit('select', undefined)
}
</script>
<template>
  <!-- Form Modal -->
  <OpModal v-if="form" @close="form = undefined">
    <StorageServiceForm
      :form="form"
      :storage="storage"
      @close="form = undefined"
    />
  </OpModal>

  <!-- user Settings -->
  <OpModal v-if="show_user_settings" @close="show_user_settings = false">
    <UserSettings :storage="storage" @close="show_user_settings = false" />
  </OpModal>

  <!-- Abort Download Modal -->
  <OpModal v-if="aborting" @close="aborting = undefined">
    <div class="modal-size-w-sm full-height-scroll gap-unit-double">
      <h4 class="text-center">
        {{
          i18n.t('_storage_files.abort_download_msg', { label: aborting.label })
        }}
      </h4>
      <div class="flex-row-center-unit justify-center">
        <op-btn color="inherit" @click="aborting = undefined">
          <op-icon icon="xmark" />
          {{ i18n.t('cancel') }}
        </op-btn>
        <op-btn
          color="red"
          @click="aborting?.stopDownload(), (aborting = undefined)"
        >
          <op-icon icon="stop" />
          {{ i18n.t('_storage_files.abort_download') }}
        </op-btn>
      </div>
    </div>
  </OpModal>

  <!-- Delete Modal -->
  <OpModal v-if="deleting" @close="clearDelete()">
    <div class="modal-size-w-sm full-height-scroll gap-unit-double">
      <h4>
        {{ i18n.t('_storage_data.delete_storage', { label: deleting.label }) }}
      </h4>
      <div class="full-height-scroll gap-unit">
        <div class="bg-red bg-opacity-20 p-unit rounded-md">
          <OpCheck v-model="delete_downloaded" color="red">
            {{ i18n.t('_storage_data.delete_local_files') }}
          </OpCheck>
        </div>
      </div>
      <div class="flex-row-center-unit justify-center">
        <op-btn color="inherit" @click="clearDelete()">
          <op-icon icon="xmark" />
          {{ i18n.t('cancel') }}
        </op-btn>
        <op-btn color="red" @click="deleteConfig()">
          <op-icon icon="trash-can" />
          {{ i18n.t('delete') }}
        </op-btn>
      </div>
    </div>
  </OpModal>

  <OpModal
    v-for="config in configs_with_duplicate_images"
    :key="config.id"
    @close="config.confirmDuplicatesAndContinue()"
  >
    <div class="modal-size-w-sm full-height-scroll gap-unit-double">
      <h4 class="flex-row-center-unit">
        <op-icon icon="triangle-exclamation" size="xl" class="text-warning" />
        {{
          i18n.t('_storage_data.config_has_duplicates', {
            config: config.label,
          })
        }}
      </h4>
      <div>
        {{ i18n.t('_storage_data.config_has_duplicates_description') }}
      </div>

      <div class="full-height-scroll gap-unit-double pr-unit-half">
        <!-- files list -->
        <div
          v-for="[name, val] in config.duplicated_images"
          :key="name"
          class="flex flex-col gap-unit-half"
        >
          <b>
            {{ name }}
          </b>
          <op-card v-for="[token, value] in val" :key="token" pad="compact">
            <div v-for="x in value" :key="x.field_name">
              {{ $t('field') }} : {{ x.field_name }}, {{ $t('resource') }}:
              {{ x.resource_name }}
            </div>
            <div class="font-mono opacity-50 text-sm">
              {{ $t('token') }}: {{ token }}
            </div>
          </op-card>
        </div>
      </div>

      <op-btn
        class="self-center"
        @click="config.confirmDuplicatesAndContinue()"
      >
        <op-icon icon="check" />
        {{ $t('continue') }}
      </op-btn>
    </div>
  </OpModal>

  <div
    class="full-height-scroll m-unit mt-0 gap-unit-double"
    style="width: 50rem"
  >
    <!-- Search and add btn -->
    <div class="flex-row-center gap-unit pr-unit-half">
      <div class="flex-row-center grow">
        <op-btn
          color="inherit"
          pad="p-unit"
          col
          @click="show_user_settings = true"
        >
          <op-icon icon="gear" size="lg" />
        </op-btn>
        <op-search v-model="search_query" grow />
      </div>

      <op-clickable-card radius="full" row middle @click="openForm()">
        <op-icon icon="plus" />
        {{ i18n.t('_storage_data.add_new_storage') }}
      </op-clickable-card>
    </div>

    <!-- Items List -->
    <div class="full-height-scroll pr-unit-half gap-unit">
      <div v-for="config in filtered_configs" :key="config.id">
        <StorageServiceItem
          :storage="storage"
          :config="config"
          @edit="openForm(config.getConfig())"
          @abort-download="aborting = config"
          @delete="deleting = config"
        />
      </div>
      <div
        v-if="!filtered_configs.length"
        class="flex-col-center italic opacity-20 py-unit text-2xl"
      >
        {{ i18n.t('no_items') }}
      </div>
    </div>
  </div>
</template>
