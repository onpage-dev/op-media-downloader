<script lang="ts" setup>
import { FolderConfig, FolderConfigJson } from '@classes/folder-config'
import { StorageService } from '@classes/store'
import { v4 as uuidv4 } from 'uuid'
import { computed, Ref, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import OpCheck from '../op-check.vue'
import OpModal from '../op-modal.vue'
import UserSettings from '../user-settings.vue'
import StorageDataDuplicateList from './storage-data-duplicate-list.vue'
import StorageServiceForm from './storage-data-form.vue'
import StorageServiceItem from './storage-data-item.vue'

const { t } = useI18n()
const emit = defineEmits<{
  select: [value?: FolderConfigJson]
}>()
const props = defineProps<{
  storage: StorageService
  selected?: FolderConfigJson
}>()
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
const configs_with_duplicate_files = computed(() => {
  return Array.from(props.storage.configs.values()).filter(
    config => config.duplicated_files.size && !config.loaders.size,
  )
})

function openForm(f?: FolderConfigJson): void {
  form.value = f ?? {
    api_token: '',
    folder_path: '',
    id: uuidv4(),
    keep_old_files: false,
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
    window.electron.ipcRenderer.send(
      'delete-folder',
      deleting.value.folder_path,
    )
  }
  clearDelete()
  emit('select', undefined)
}
</script>
<template>
  <!-- Form Modal -->
  <Transition name="modal-fade">
    <OpModal v-if="form" @close="form = undefined">
      <StorageServiceForm
        :form="form"
        :storage="storage"
        @close="form = undefined"
      />
    </OpModal>
  </Transition>

  <!-- User Settings -->
  <Transition name="modal-fade">
    <OpModal v-if="show_user_settings" @close="show_user_settings = false">
      <UserSettings :storage="storage" @close="show_user_settings = false" />
    </OpModal>
  </Transition>

  <!-- Abort Download Modal -->
  <Transition name="modal-fade">
    <OpModal v-if="aborting" @close="aborting = undefined">
      <div class="modal-size-w-sm full-height-scroll gap-unit-double">
        <h4 class="text-center">
          {{
            t('_storage_files.abort_download_msg', {
              label: aborting.label,
            })
          }}
        </h4>
        <div class="flex-row-center-unit justify-center">
          <op-btn color="inherit" @click="aborting = undefined">
            <op-icon icon="xmark" />
            {{ t('cancel') }}
          </op-btn>
          <op-btn
            color="red"
            @click="aborting?.stopDownload(), (aborting = undefined)"
          >
            <op-icon icon="stop" />
            {{ t('_storage_files.abort_download') }}
          </op-btn>
        </div>
      </div>
    </OpModal>
  </Transition>

  <!-- Delete Modal -->
  <Transition name="modal-fade">
    <OpModal v-if="deleting" @close="clearDelete()">
      <div class="modal-size-w-sm full-height-scroll gap-unit-double">
        <h4>
          {{ t('_storage_data.delete_storage', { label: deleting.label }) }}
        </h4>
        <div class="full-height-scroll gap-unit">
          <div class="bg-red bg-opacity-20 p-unit rounded-md">
            <OpCheck v-model="delete_downloaded" color="red">
              {{ t('_storage_data.delete_local_files') }}
            </OpCheck>
          </div>
        </div>
        <div class="flex-row-center-unit justify-center">
          <op-btn color="inherit" @click="clearDelete()">
            <op-icon icon="xmark" />
            {{ t('cancel') }}
          </op-btn>
          <op-btn color="red" @click="deleteConfig()">
            <op-icon icon="trash-can" />
            {{ t('delete') }}
          </op-btn>
        </div>
      </div>
    </OpModal>
  </Transition>

  <!-- Duplicates modal -->
  <TransitionGroup name="modal-fade">
    <OpModal
      v-for="config in configs_with_duplicate_files"
      :key="config.id"
      @close="config.confirmDuplicatesAndContinue()"
    >
      <StorageDataDuplicateList :config="config" />
    </OpModal>
  </TransitionGroup>

  <div
    class="full-height-scroll m-unit mt-0 gap-unit-double"
    style="width: 50rem"
  >
    <!-- Search and add btn -->
    <div class="flex-row-center gap-unit pr-unit-half">
      <op-search v-model="search_query" grow radius="md" autofocus />

      <div class="flex flex-row">
        <op-clickable-card
          :radius="0"
          class="rounded-l-md border-r-0"
          middle
          col
          @click="show_user_settings = true"
        >
          <op-icon icon="gear" size="lg" />
        </op-clickable-card>
        <op-clickable-card
          :radius="0"
          class="rounded-r-md"
          middle
          row
          @click="openForm()"
        >
          <op-icon icon="plus" />
          {{ t('_storage_data.add_new_storage') }}
        </op-clickable-card>
      </div>
    </div>

    <!-- Items List -->
    <div class="full-height-scroll pr-unit-half gap-unit">
      <StorageServiceItem
        v-for="config in filtered_configs"
        :key="config.id"
        :storage="storage"
        :config="config"
        @edit="openForm(config.getConfig())"
        @abort-download="aborting = config"
        @delete="deleting = config"
      />
      <div
        v-if="!filtered_configs.length"
        class="flex-col-center opacity-20 p-20 text-3xl"
      >
        {{ storage.configs.size ? t('no_result') : t('no_items') }}
      </div>
    </div>
  </div>
</template>
