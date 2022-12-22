<script lang="ts" setup>
import { toggleUserProperty } from '@renderer/service/utils'
import { StorageData } from '../../classes/folder-config'
import { computed, onBeforeMount, ref } from 'vue'
import OpLogo from './op-logo.vue'

const props = defineProps({
  storage: {
    type: StorageData,
    required: true,
  },
})
const is_small = ref(false)
const dark_mode = computed(() => props.storage.user_properties.dark_mode)

function toggleDarkMode(): void {
  toggleUserProperty(props.storage, 'dark_mode', !dark_mode.value)
}

onBeforeMount(() => {
  is_small.value = window.innerWidth < 1000

  window.addEventListener('resize', () => {
    is_small.value = window.innerWidth < 1000
  })
})
</script>

<template>
  <op-card class="z-40" pad="compact" middle :row="true" provide>
    <router-link :to="{ path: '/' }">
      <OpLogo
        :small="is_small"
        :dark="dark_mode"
        class="w-auto object-contain my-unit flex-shrink-0"
        style="height: 1.5rem"
      />
    </router-link>

    <div class="flex-row-center-unit ml-auto">
      <op-circle-btn @click="toggleDarkMode()">
        <op-icon :icon="dark_mode ? 'moon' : 'sun'" size="lg" />
      </op-circle-btn>
    </div>
  </op-card>
</template>
