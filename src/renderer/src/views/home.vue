<script lang="ts" setup>
import StorageServiceList from '@renderer/components/storage-data/storage-data-list.vue'
import { StorageService } from '../../classes/store'
defineProps({
  storage: {
    type: StorageService,
    required: true,
  },
})
</script>

<template>
  <StorageServiceList :storage="storage" />
</template>
