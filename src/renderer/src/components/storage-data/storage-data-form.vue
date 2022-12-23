<script lang="ts" setup>
import { cloneDeep } from 'lodash'
import { onBeforeMount, PropType, Ref, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { FolderConfig, StorageData } from '../../../classes/folder-config'

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'save', value: FolderConfig): void
}>()
const i18n = useI18n()
const props = defineProps({
  form: {
    type: Object as PropType<Partial<FolderConfig>>,
    required: true,
  },
  storage: {
    type: StorageData,
    required: true,
  },
})

const local_form: Ref<Partial<FolderConfig> | undefined> = ref(undefined)

function chooseFolder(): void {
  if (!local_form.value) return
  window.electron.ipcRenderer.invoke('pick-folder-path').then(res => {
    console.log('selected folder path', res)
    local_form.value!.folder_path = res
  })
}
async function save(): Promise<void> {
  if (!local_form.value) return

  await props.storage.setConfig(local_form.value as FolderConfig)
  emit('close')
}

onBeforeMount(() => {
  local_form.value = cloneDeep(props.form)
})
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
            @click="chooseFolder"
          >
            <op-icon icon="fa-folder-plus" />
            {{ $t('_storage_data.choose_folder') }}
          </op-clickable-card>
        </div>
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
