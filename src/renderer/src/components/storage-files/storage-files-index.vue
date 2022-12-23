<script lang="ts" setup>
import { computed, onBeforeMount, PropType, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FolderConfig, StorageData } from '../../../classes/folder-config'
import dayjs from 'dayjs'
import de from 'dayjs/locale/de'
import en from 'dayjs/locale/en'
import es from 'dayjs/locale/es'
import fr from 'dayjs/locale/fr'
import it from 'dayjs/locale/it'
import ru from 'dayjs/locale/ru'
import zh from 'dayjs/locale/zh'

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
const total_files_to_download = computed(
  () => config_service.value?.all_files_raw.length,
)
const downloaded_files = computed(() =>
  Array.from(config_service.value?.download_loaders ?? [])
    .map(([, val]) => val)
    .filter(val => !val.downloading),
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
function setLocale(): void {
  switch (i18n.locale.value) {
    case 'de':
      dayjs.locale(de)
      break
    case 'en':
      dayjs.locale(en)
      break
    case 'es':
      dayjs.locale(es)
      break
    case 'fr':
      dayjs.locale(fr)
      break
    case 'it':
      dayjs.locale(it)
      break
    case 'ru':
      dayjs.locale(ru)
      break
    case 'zh':
      dayjs.locale(zh)
      break
    default:
      dayjs.locale(it)
  }
}

watch(
  () => config_service.value?.is_downloading,
  new_val => {
    if (!new_val) {
      config_service.value?.loadLocalFiles()
    }
  },
)

onBeforeMount(() => setLocale())
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
        <div v-if="config_service?.is_downloading">
          {{ downloaded_files }}/{{ total_files_to_download }}
        </div>
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
        <template v-else-if="config_service">
          <op-card
            v-if="config_service.last_sync"
            class="flex flex-col gap-unit"
            col
          >
            <h5>{{ i18n.t('_storage_files.last_sync') }}</h5>
            <div class="flex-row-center-unit text-sm opacity-50">
              <op-icon icon="calendar" />
              {{
                dayjs(config_service.last_sync.start_time).format(
                  'DD MMM YYYY HH:mm',
                )
              }}
              -
              {{
                dayjs(config_service.last_sync.end_time).format(
                  'DD MMM YYYY HH:mm',
                )
              }}
            </div>
            <div class="flex-row-center-unit">
              <op-icon icon="computer" />
              {{ config_service.last_sync.local_files.length }}
              {{ i18n.t('_storage_files.local_files') }}
            </div>
            <div class="flex-row-center-unit">
              <op-icon icon="server" />
              {{ config_service.last_sync.remote_files.length }}
              {{ i18n.t('_storage_files.remote_file') }}
            </div>
          </op-card>
        </template>
      </div>
    </template>
  </div>
</template>
