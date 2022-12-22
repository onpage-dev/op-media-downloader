<script lang="ts" setup>
import StorageDataList from '@renderer/components/storage-data/storage-data-list.vue'
import { StorageData } from '../../classes/folder-config'
defineProps({
  storage: {
    type: StorageData,
    required: true,
  },
})
</script>

<template>
  <div class="flex flex-row gap-unit">
    <StorageDataList :storage-data="storage" />
  </div>
</template>
