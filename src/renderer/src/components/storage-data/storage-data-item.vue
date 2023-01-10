<script lang="ts" setup>
import { PropType } from 'vue'
import { FolderConfig } from '../../../classes/folder-config'
import SyncLoaderStatus from '../storage-files/sync-loader-status.vue'

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
</script>
<template>
  <div class="flex flex-col gap-unit">
    <op-card class="text-left relative group" col>
      <div
        class="flex-row-center-unit absolute right-unit top-unit opacity-0 group-hover:opacity-100 duration-100"
      >
        <div class="sober-link-accent" @click.stop="$emit('edit')">
          <op-icon icon="pen-to-square" />
        </div>
        <div class="sober-link-danger" @click.stop="$emit('delete')">
          <op-icon icon="trash-can" />
        </div>
      </div>
      <div>{{ config.label }}</div>
      <div class="text-sm font-mono opacity-50">{{ config.api_token }}</div>
      <div class="text-sm font-mono opacity-50 ellipses">
        {{ config.folder_path }}
      </div>
    </op-card>
    <div
      v-if="config.current_sync || config.last_sync"
      class="flex-nowrap flex-row-center-unit text-sm"
    >
      <SyncLoaderStatus :loader="config.current_sync ?? config.last_sync" />
    </div>
    <!-- Update -->
    <op-clickable-tag
      class="ml-auto min-w-0"
      :class="{
        'opacity-50': config.is_loading,
      }"
      :disabled="config.is_loading"
      :loading="config.is_loading"
      @click="syncOrLoad"
    >
      <op-icon
        :icon="config.images_raw_by_token.size ? 'download' : 'arrows-rotate'"
      />
      <div v-if="config.images_raw_by_token.size">
        {{ $t('_storage_files.download') }}
        +{{ config.images_raw_by_token.size }}
      </div>
      <div v-else>
        {{ $t('_storage_files.start_sync') }}
      </div>
    </op-clickable-tag>
  </div>
</template>
