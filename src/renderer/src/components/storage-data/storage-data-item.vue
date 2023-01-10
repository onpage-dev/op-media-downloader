<script lang="ts" setup>
import { FolderConfig } from '@classes/folder-config'
import dayjs from 'dayjs'
import de from 'dayjs/locale/de'
import en from 'dayjs/locale/en'
import es from 'dayjs/locale/es'
import fr from 'dayjs/locale/fr'
import it from 'dayjs/locale/it'
import ru from 'dayjs/locale/ru'
import zh from 'dayjs/locale/zh'
import { onBeforeMount, PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import SyncLoaderStatus from '../sync-loader-status.vue'

const i18n = useI18n()
defineEmits(['edit', 'delete'])
const props = defineProps({
  config: {
    type: Object as PropType<FolderConfig>,
    required: true,
  },
})
function syncOrLoad(): void {
  if (props.config.is_loading) return
  if (props.config.images_raw_by_token.size) {
    props.config?.downloadFiles()
  } else {
    props.config.loadRemoteFiles()
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
onBeforeMount(() => setLocale())
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
          <span>
            <op-icon
              :icon="
                config.images_raw_by_token.size ? 'download' : 'arrows-rotate'
              "
            />
            <span v-if="config.images_raw_by_token.size" class="pl-unit">
              {{ i18n.t('_storage_files.download') }}
              {{ config.images_raw_by_token.size }}
            </span>
            <span v-else class="pl-unit">
              {{ i18n.t('_storage_files.start_sync') }}
            </span>
          </span>
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
