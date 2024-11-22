<script lang="ts" setup>
import { FolderConfigJson } from '@classes/folder-config'
import { StorageService } from '@classes/store'
import { cloneDeep } from 'lodash'
import { reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import OpToggle from '../op-toggle.vue'

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'save', value: FolderConfigJson): void
}>()
const i18n = useI18n()
const props = defineProps<{
  form: FolderConfigJson
  storage: StorageService
}>()

const local_form = reactive(cloneDeep(props.form))

function chooseFolder(): void {
  if (!local_form) return
  window.electron.ipcRenderer.invoke('pick-folder-path').then(res => {
    console.log('selected folder path', res)
    local_form!.folder_path = res
  })
}
async function save(): Promise<void> {
  if (!local_form) return
  await props.storage.setConfig(local_form)
  emit('close')
}
</script>
<template>
  <form
    v-if="local_form"
    class="modal-size-w-sm full-height-scroll gap-unit-double"
    @submit.prevent="save()"
  >
    <h4>
      {{
        form.api_token
          ? i18n.t('_storage_data.edit_storage', { label: form.label })
          : i18n.t('_storage_data.add_new_storage')
      }}
    </h4>

    <div class="full-height-scroll gap-unit">
      <div class="flex flex-col">
        <div class="flex-row-center-unit">
          {{ i18n.t('_storage_data.label') }}
        </div>

        <op-input v-model="local_form.label" required />
      </div>

      <div class="flex flex-col">
        <div class="flex-row-center-unit">
          {{ i18n.t('_storage_data.api_token') }}
        </div>

        <op-input v-model="local_form.api_token" required />
      </div>

      <div class="flex flex-col">
        <div class="flex-row-center-unit">
          {{ i18n.t('_storage_data.folder_path') }}
        </div>
        <div class="flex flex-row">
          <op-input
            v-model="local_form.folder_path"
            class="rounded-r-none"
            required
            grow
          />

          <op-clickable-card
            pad="compact"
            class="border-l-0 rounded-l-none"
            row
            middle
            @click="chooseFolder()"
          >
            <op-icon icon="fa-folder-plus" />
            {{ $t('_storage_data.choose_folder') }}
          </op-clickable-card>
        </div>
      </div>

      <OpToggle v-model="local_form.keep_old_files" acolor="warning">
        {{ $t('_storage_data.keep_old_files') }}
      </OpToggle>
      <div
        v-if="local_form.keep_old_files"
        class="flex flex-row items-center gap-unit bg-warning bg-opacity-20 p-unit rounded-md"
      >
        <op-icon icon="exclamation-triangle" size="xl" class="text-warning" />
        {{ $t('_storage_data.keep_old_files_msg') }}
      </div>
    </div>

    <div class="flex-row-center-unit justify-center">
      <op-cancel @click="emit('close')">
        <op-icon icon="xmark" />
        {{ i18n.t('cancel') }}
      </op-cancel>
      <op-submit>
        <op-icon icon="save" />
        {{ i18n.t('save') }}
      </op-submit>
    </div>
  </form>
</template>
