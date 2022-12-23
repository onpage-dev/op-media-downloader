<script lang="ts" setup>
import { computed, PropType, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FolderConfig, StorageData } from '../../../classes/folder-config'
import OpTable from '../op-table.vue'

const i18n = useI18n()
const props = defineProps({
  storage: {
    type: StorageData,
    required: true,
  },
  config: {
    type: Object as PropType<FolderConfig>,
  },
})

const config_service = computed(() => {
  if (!props.config) return
  return props.storage.config_services.get(props.config.api_token)
})
const local_file_tokens = computed(
  () => config_service.value?.local_file_tokens,
)
async function doSync(): Promise<void> {
  await config_service.value?.syncFiles()
}
function openPath(file_name?: string): void {
  window.electron.ipcRenderer.send(
    'openPath',
    `${config_service.value?.folder_path}${file_name ? '/' + file_name : ''}`,
  )
}

watch(
  () => config_service.value?.is_downloading,
  new_val => {
    if (!new_val) {
      config_service.value?.loadLocalFiles()
    }
  },
)
</script>
<template>
  <div class="full-height-scroll-wfull gap-unit mr-unit mb-unit">
    <!-- Select config msg -->
    <div
      v-if="!config"
      class="full-height-scroll gap-unit-double items-center justify-center text-2xl opacity-30"
    >
      <op-icon icon="shapes" size="2x" />
      {{ i18n.t('_storage_files.select_project') }}
    </div>

    <template v-else>
      <!-- Title -->
      <h4 class="flex-row-center-unit">
        <op-icon icon="folder" class="text-accent" />
        {{ i18n.t('_storage_files.title') }}
      </h4>

      <!-- Action btns -->
      <div class="flex-row-center gap-unit text-base pr-unit-half">
        <op-clickable-tag @click="openPath()">
          <op-icon icon="folder-open" />
          {{ i18n.t('_storage_files.reveal_in_explorer') }}
        </op-clickable-tag>

        <op-clickable-tag
          class="ml-auto"
          :class="{
            'opacity-50': config_service?.is_downloading,
          }"
          :disabled="config_service?.is_downloading"
          @click="!config_service?.is_downloading && doSync()"
        >
          <op-icon
            icon="arrows-rotate"
            :spin="!!config_service?.is_downloading"
          />
          {{ i18n.t('_storage_files.start_sync') }}
        </op-clickable-tag>
      </div>

      <!-- Content -->
      <div class="full-height-scroll gap-unit pr-unit-half">
        <!-- No elements or loading -->
        <div
          v-if="config_service?.is_loading || !local_file_tokens?.length"
          class="full-height-scroll gap-unit-double items-center justify-center py-unit-double italic opacity-50 text-2xl"
        >
          <template v-if="config_service?.is_loading">
            <op-icon icon="arrows-rotate" spin />
            {{ i18n.t('loading') }}
          </template>
          <template v-else>
            <op-icon icon="file" size="2x" />
            {{ i18n.t('no_items') }}
          </template>
        </div>
        <!-- FilesList -->
        <OpTable v-else sticky striped hover>
          <thead>
            <tr>
              <th>{{ i18n.t('_storage_files.local_files') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="file in local_file_tokens"
              :key="file"
              @click="openPath(file)"
            >
              <td>{{ file }}</td>
            </tr>
          </tbody>
        </OpTable>
      </div>
    </template>
  </div>
</template>
