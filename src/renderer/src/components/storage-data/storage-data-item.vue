<script lang="ts" setup>
import { FolderConfig } from '@classes/folder-config'
import { StorageService } from '@classes/store'
import dayjs from 'dayjs'
import en from 'dayjs/locale/en'
import it from 'dayjs/locale/it'
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SyncLoaderStatus from '../sync-loader-status.vue'

const { t, locale } = useI18n()
defineEmits<{
  edit: []
  delete: []
  'abort-download': []
}>()
const props = defineProps<{
  storage: StorageService
  config: FolderConfig
}>()

const is_loading = computed(() => props.config.is_loading)
function syncOrLoad(): void {
  if (is_loading.value) return
  if (props.config.raw_files_by_token.size) {
    if (props.config.files_to_download.length) {
      props.config.downloadFiles()
    } else {
      props.config.raw_files_by_token.clear()
    }
  } else {
    props.config.loadRemoteFiles().then(() => {
      if (!props.config.duplicated_files.size) {
        props.config.checkMissingTokens()
      }
    })
  }
}
function openPath(file_name?: string): void {
  window.electron.ipcRenderer.send(
    'open-path',
    `${props.config.folder_path}${file_name ? '/' + file_name : ''}`,
  )
}
function setLocale(): void {
  switch (locale.value) {
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
  () => locale.value,
  () => {
    setLocale()
  },
  { immediate: true },
)
</script>
<template>
  <op-card class="gap-unit" radius="xl" provide>
    <!-- Header and btns -->
    <div class="flex-row-center-unit" col>
      <h5>{{ config.label }}</h5>
      <div class="flex flex-row ml-auto">
        <!-- Edit -->
        <op-btn
          v-tooltip="t('edit')"
          color="inherit"
          pad="compact"
          radius="md"
          @click="$emit('edit')"
        >
          <op-icon icon="pen-to-square" />
        </op-btn>

        <!-- Delete -->
        <op-btn
          v-tooltip="t('delete')"
          class="group"
          color="inherit"
          pad="compact"
          radius="md"
          @click="$emit('delete')"
        >
          <op-icon icon="trash-can" class="group-hover:text-red duration-100" />
        </op-btn>

        <op-btn
          v-tooltip="t('_storage_files.reveal_in_explorer')"
          class="min-w-0"
          color="inherit"
          pad="compact"
          radius="md"
          @click="openPath()"
        >
          <op-icon icon="folder-open" />
        </op-btn>

        <!-- Update -->
        <op-btn
          v-if="!config.failed_schema_load"
          class="min-w-0"
          :class="{
            'opacity-50': is_loading,
          }"
          color="inherit"
          pad="compact"
          radius="md"
          :active="config.load_fields_error"
          acolor="red"
          :disabled="is_loading"
          :loading="is_loading"
          @click="syncOrLoad()"
        >
          <template v-if="config.load_fields_error">
            <op-icon icon="arrows-rotate" />
            {{ t('_storage_files.error') }}
          </template>
          <template v-else-if="!config.raw_files_by_token.size">
            <op-icon icon="arrows-rotate" />
            {{ t('_storage_files.start_sync') }}
          </template>
          <template v-else-if="config.is_downloading">
            {{ t('_storage_files.downloading') }}
          </template>
          <template v-else-if="is_loading">
            {{ t('loading') }}
          </template>
          <template v-else-if="config.files_to_download.length">
            <op-icon icon="download" />
            {{ t('_storage_files.download') }}
            +{{ config.files_to_download.length }}
          </template>
          <template v-else>
            <op-icon icon="check" />
            {{ t('_storage_files.no_files_to_download') }}
          </template>
        </op-btn>
        <op-btn
          v-else
          v-tooltip="t('schema_load_failed_msg')"
          color="inherit"
          :class="{
            'opacity-50': is_loading,
          }"
          :disabled="is_loading"
          :loading="is_loading"
          acolor="orange"
          active
          pad="compact"
          @click="config.refresh()"
        >
          <span>
            <op-icon icon="triangle-exclamation" class="text-orange" />
            {{ t('failed_to_load_schema') }}
          </span>
        </op-btn>

        <op-btn
          v-if="config.is_downloading"
          class="min-w-0"
          color="inherit"
          pad="compact"
          :loading="config.is_stopping"
          @click="$emit('abort-download')"
        >
          <div class="flex-row-center-unit sober-link-danger">
            <op-icon icon="stop" />
            {{ t('_storage_files.abort_download') }}
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
        <b>{{ t('_storage_files.last_sync') }}</b>
        <span class="opacity-50">
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
