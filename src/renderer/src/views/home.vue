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
  <StorageDataList :storage="storage" />
</template>
