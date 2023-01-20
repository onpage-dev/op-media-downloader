<script lang="ts" setup>
import { FolderConfig } from '@classes/folder-config'
import { StorageService } from '@classes/store'
import dayjs from 'dayjs'
import en from 'dayjs/locale/en'
import it from 'dayjs/locale/it'
import { PropType, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SyncLoaderStatus from '../sync-loader-status.vue'

const i18n = useI18n()
defineEmits(['edit', 'delete', 'abort-download'])
const props = defineProps({
  storage: {
    type: StorageService,
    required: true,
  },
  config: {
    type: Object as PropType<FolderConfig>,
    required: true,
  },
})

function syncOrLoad(): void {
  if (props.config.is_loading) return
  if (props.config.images_raw_by_token.size) {
    if (props.config.images_to_download.length) {
      props.config?.downloadFiles()
    } else {
      props.config.images_raw_by_token.clear()
    }
  } else {
    props.config.loadRemoteFiles().then(() => {
      window.electron.ipcRenderer.send(
        'checkMissingTokens',
        props.config.id,
        Array.from(props.config.images_raw_by_token.keys()),
        props.config.folder_path,
      )
    })
  }
}
function openPath(file_name?: string): void {
  window.electron.ipcRenderer.send(
    'openPath',
    `${props.config.folder_path}${file_name ? '/' + file_name : ''}`,
  )
}
function setLocale(): void {
  switch (i18n.locale.value) {
    case 'en':
      dayjs.locale(en)
      break
    case 'it':
      dayjs.locale(it)
      break
    default:
      dayjs.locale(it)
  }
}
watch(
  () => i18n.locale.value,
  () => {
    setLocale()
  },
  { immediate: true },
)
</script>
<template>
  <op-card class="gap-unit" provide>
    <!-- Header and btns -->
    <div class="flex-row-center-unit" col>
      <h5>{{ config.label }}</h5>
      <div class="flex flex-row ml-auto">
        <!-- Edit -->
        <op-btn
          v-tooltip="i18n.t('edit')"
          class="link-opacity"
          color="inherit"
          pad="compact"
          @click="$emit('edit')"
        >
          <op-icon icon="pen-to-square" />
        </op-btn>

        <!-- Delete -->
        <op-btn
          v-tooltip="i18n.t('delete')"
          class="link-opacity group"
          color="inherit"
          pad="compact"
          @click="$emit('delete')"
        >
          <op-icon icon="trash-can" class="group-hover:text-red duration-100" />
        </op-btn>

        <op-btn
          v-tooltip="i18n.t('_storage_files.reveal_in_explorer')"
          class="min-w-0"
          color="inherit"
          pad="compact"
          @click="openPath()"
        >
          <op-icon icon="folder-open" />
        </op-btn>

        <!-- Update -->
        <op-btn
          v-if="!config.failed_schema_load"
          class="min-w-0"
          :class="{
            'opacity-50': config.is_loading,
          }"
          color="inherit"
          pad="compact"
          :disabled="config.is_loading"
          :loading="config.is_loading"
          @click="syncOrLoad"
        >
          <template v-if="!config.images_raw_by_token.size">
            <op-icon icon="arrows-rotate" />
            {{ i18n.t('_storage_files.start_sync') }}
          </template>
          <template v-else-if="config.is_downloading">
            {{ i18n.t('_storage_files.downloading') }}
          </template>
          <template v-else-if="config.is_loading">
            {{ i18n.t('loading') }}
          </template>
          <template v-else-if="config.images_to_download.length">
            <op-icon icon="download" />
            {{ i18n.t('_storage_files.download') }}
            +{{ config.images_to_download.length }}
          </template>
          <template v-else>
            <op-icon icon="check" />
            {{ i18n.t('_storage_files.no_files_to_download') }}
          </template>
        </op-btn>
        <op-btn
          v-else
          v-tooltip="i18n.t('schema_load_failed_msg')"
          color="inherit"
          :class="{
            'opacity-50': config.is_loading,
          }"
          :disabled="config.is_loading"
          :loading="config.is_loading"
          acolor="orange"
          active
          pad="compact"
          @click="config.refresh()"
        >
          <span>
            <op-icon icon="triangle-exclamation" class="text-orange" />
            {{ i18n.t('failed_to_load_schema') }}
          </span>
        </op-btn>

        <!-- TODO: Implement Abort functionality -->
        <op-btn
          v-if="false && config.is_downloading"
          class="min-w-0"
          color="inherit"
          pad="compact"
          :disabled="config.is_loading"
          :loading="config.is_loading"
          @click="$emit('abort-download')"
        >
          <div class="flex-row-center-unit sober-link-danger">
            <op-icon icon="stop" />
            {{ i18n.t('_storage_files.abort_download') }}
          </div>
        </op-btn>
      </div>
    </div>
    <div
      v-if="config.current_sync || config.last_sync"
      class="flex flex-col gap-unit"
    >
      <!-- Last Sync info -->
      <div
        v-if="config.last_sync"
        class="flex-row-center-unit justify-between text-sm"
      >
        <b>{{ i18n.t('_storage_files.last_sync') }}</b>
        <span class="opacity-50">
          <op-icon icon="calendar" />
          {{ dayjs(config.last_sync.start_time).format('DD MMM YYYY HH:mm') }}
          -
          {{ dayjs(config.last_sync.end_time).format('DD MMM YYYY HH:mm') }}
        </span>
      </div>

      <div class="flex-nowrap flex-row-center-unit text-sm">
        <SyncLoaderStatus :loader="config.current_sync ?? config.last_sync" />
      </div>
    </div>
  </op-card>
</template>
