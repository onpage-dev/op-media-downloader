<script lang="ts" setup>
import LocalStoreDataList from '@renderer/components/storage-data/storage-data-list.vue'
import StorageFilesIndex from '@renderer/components/storage-files/storage-files-index.vue'
import { Ref, ref } from 'vue'
import { FolderConfigJson } from '../../classes/folder-config'
import { LocalStoreData } from '../../classes/store'
defineProps({
  localStoreData: {
    type: LocalStoreData,
    required: true,
  },
})
const selected_local_store_data: Ref<FolderConfigJson | undefined> =
  ref(undefined)
</script>

<template>
  <div class="flex flex-row flex-grow overflow-auto">
    <LocalStoreDataList
      :local-store-data="localStoreData"
      :selected="selected_local_store_data"
      @select="selected_local_store_data = $event"
    />
    <StorageFilesIndex
      :local-store-data="localStoreData"
      :config_id="selected_local_store_data?.id"
    />
  </div>
  {{ [selected_local_store_data?.id] }}
</template>
