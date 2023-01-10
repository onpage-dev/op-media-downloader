<script lang="ts" setup>
import { FolderConfigJson } from '@classes/folder-config'
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

  <div
    class="full-height-scroll m-unit mt-0 gap-unit-double"
    style="width: 50rem"
  >
    <!-- Search and add btn -->
    <div class="flex flex-row gap-unit pr-unit-half">
      <op-clickable-card
        radius="full"
        pad="compact"
        col
        @click="show_user_settings = true"
      >
        <op-icon icon="gear" />
      </op-clickable-card>
      <op-search v-model="search_query" grow />

      <op-clickable-card radius="full" row middle @click="openForm()">
        <op-icon icon="plus" />
        {{ i18n.t('_storage_data.add_new_storage') }}
      </op-clickable-card>
    </div>

    <!-- Items List -->
    <div class="full-height-scroll pr-unit-half gap-unit">
      <div v-for="config in filtered_configs" :key="config.id">
        <StorageServiceItem
          :config="config"
          @edit="openForm(config.getConfig())"
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
