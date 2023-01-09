<script lang="ts" setup>
import { computed, onBeforeMount, ref } from 'vue'
import { LocalStoreData } from '../../classes/store'
import OpLogo from './op-logo.vue'

const props = defineProps({
  localStoreData: {
    type: LocalStoreData,
    required: true,
  },
})
const is_small = ref(false)
const dark_mode = computed(() => props.localStoreData.user_properties.dark_mode)

function toggleDarkMode(): void {
  props.localStoreData.set('user_properties.dark_mode', !dark_mode.value)
}

onBeforeMount(() => {
  is_small.value = window.innerWidth < 400

  window.addEventListener('resize', () => {
    is_small.value = window.innerWidth < 400
  })
})
</script>

<template>
  <op-card class="z-40 m-unit mb-0" pad="compact" middle :row="true" provide>
    <OpLogo
      :small="is_small"
      :dark="dark_mode"
      class="w-auto object-contain my-unit flex-shrink-0"
      style="height: 1.5rem"
    />

    <div class="flex-row-center-unit ml-auto">
      <op-circle-btn @click="toggleDarkMode()">
        <op-icon :icon="dark_mode ? 'moon' : 'sun'" size="lg" />
      </op-circle-btn>
    </div>
  </op-card>
</template>
