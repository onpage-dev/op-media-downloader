<script lang="ts" setup>
import dayjs from 'dayjs'
import de from 'dayjs/locale/de'
import en from 'dayjs/locale/en'
import es from 'dayjs/locale/es'
import fr from 'dayjs/locale/fr'
import it from 'dayjs/locale/it'
import ru from 'dayjs/locale/ru'
import zh from 'dayjs/locale/zh'
import { computed, onBeforeMount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { LocalStoreData } from '../../../classes/store'
import SyncLoaderStatus from './sync-loader-status.vue'

const i18n = useI18n()
const props = defineProps({
  localStoreData: {
    type: LocalStoreData,
    required: true,
  },
  config_id: {
    type: String,
  },
})

const config_service = computed(() => {
  if (!props.config_id) return
  return props.localStoreData.config_services.get(props.config_id)
})

const is_downloading = computed(() => {
  return config_service.value?.is_downloading || false
})

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
  () => config_service.value?.api_token,
  async () => {
    await config_service.value?.loadRemoteFiles()
  },
  { immediate: true },
)
onBeforeMount(() => setLocale())
</script>
<template>
  <div class="full-height-scroll-wfull gap-unit mr-unit mb-unit">
    <!-- Select config msg -->
    <div
      v-if="!config_service"
      class="full-height-scroll gap-unit-double items-center justify-center text-2xl opacity-30"
    >
      <op-icon icon="shapes" size="2x" />
      {{ i18n.t('_storage_files.select_project') }}
    </div>

    <template v-else-if="config_service">
      <!-- Title -->
      <h4 class="flex-row-center-unit">
        <op-icon icon="folder" class="text-accent" />
        {{ i18n.t('_storage_files.title') }}
      </h4>

      <!-- Action btns -->
      <div class="flex-row-center gap-unit text-base pr-unit-half">
        <!-- Open folder -->
        <op-clickable-tag class="min-w-0" @click="openPath()">
          <op-icon icon="folder-open" />

          <div class="ellipses">
            {{ i18n.t('_storage_files.reveal_in_explorer') }}
          </div>
        </op-clickable-tag>

        <!-- Start sync -->
        <op-clickable-tag
          class="ml-auto min-w-0"
          :class="{
            'opacity-50': config_service.is_loading,
          }"
          :disabled="config_service.is_loading"
          @click="!config_service?.is_loading && config_service?.syncFiles()"
        >
          <op-icon icon="arrows-rotate" :spin="is_downloading" />
          <div class="ellipses">
            {{ i18n.t('_storage_files.start_sync') }}
          </div>
        </op-clickable-tag>
      </div>

      <!-- Content -->
      <div class="full-height-scroll gap-unit pr-unit-half">
        <!-- Sync on going  -->
        <op-card v-if="config_service.is_downloading" middle row>
          <SyncLoaderStatus :loader="config_service.sync_loader" />
        </op-card>

        <!-- Loading or No elements -->
        <div
          v-else-if="
            config_service.is_loading ||
            !config_service.local_file_tokens.length
          "
          class="full-height-scroll gap-unit-double items-center justify-center py-unit-double italic opacity-50 text-2xl"
        >
          <template v-if="config_service.is_loading">
            <op-icon icon="arrows-rotate" spin />
            {{ i18n.t('loading') }}
          </template>
          <template v-else>
            <op-icon icon="file" size="2x" />
            {{ i18n.t('no_items') }}
          </template>
        </div>

        <!-- Files List -->
        <template v-else>
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
            <div class="flex-row-center-unit flex-wrap text-sm">
              <SyncLoaderStatus :loader="config_service.last_sync" />
            </div>
          </op-card>
        </template>
      </div>
    </template>
  </div>
</template>
