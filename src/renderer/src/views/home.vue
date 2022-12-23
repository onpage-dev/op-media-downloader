<script lang="ts" setup>
import StorageDataList from '@renderer/components/storage-data/storage-data-list.vue'
import StorageFilesIndex from '@renderer/components/storage-files/storage-files-index.vue'
import { Ref, ref } from 'vue'
import { FolderConfig, StorageData } from '../../classes/folder-config'
defineProps({
  storage: {
    type: StorageData,
    required: true,
  },
})
const selected_storage_data: Ref<FolderConfig | undefined> = ref(undefined)
</script>

<template>
  <div class="flex flex-row flex-grow overflow-auto">
    <StorageDataList
      :storage="storage"
      :selected="selected_storage_data"
      @select="selected_storage_data = $event"
    />
    <StorageFilesIndex :storage="storage" :config="selected_storage_data" />
  </div>
</template>
