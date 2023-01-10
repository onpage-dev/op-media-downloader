<script lang="ts" setup>
import { SyncProgressInfo } from '@classes/folder-config'
import { PropType } from 'vue'
import { useI18n } from 'vue-i18n'
const emit = defineEmits<{
  (
    e: 'select',
    value: 'downloaded' | 'failed' | 'already_present' | 'total',
  ): void
}>()
const i18n = useI18n()
defineProps({
  loader: {
    type: Object as PropType<SyncProgressInfo>,
  },
  selected: {
    type: String as PropType<
      'downloaded' | 'failed' | 'already_present' | 'total'
    >,
  },
  clickable: Boolean,
})
</script>
<template>
  <template v-if="loader">
    <div
      :class="{
        'cursor-pointer': clickable,
        'ring-1 ring-green': selected == 'downloaded',
      }"
      class="select-none flex-1 flex-row-center gap-unit-half whitespace-nowrap rounded-md px-unit py-unit-half bg-green bg-opacity-20"
      @click="clickable && emit('select', 'downloaded')"
    >
      <op-icon icon="download" class="text-green" />
      {{ i18n.t('_storage_files.downloaded') }}
      {{ loader.downloaded + loader.already_exists }}
    </div>
    <div
      :class="{
        'cursor-pointer': clickable,
        'ring-1 ring-red': selected == 'failed',
      }"
      class="select-none flex-1 flex-row-center gap-unit-half whitespace-nowrap rounded-md px-unit py-unit-half bg-red bg-opacity-20"
      @click="clickable && emit('select', 'failed')"
    >
      <op-icon icon="bug" class="text-red" />
      {{ i18n.t('_storage_files.failed') }}
      {{ loader.failed ?? 0 }}
    </div>
    <div
      :class="{
        'cursor-pointer': clickable,
        'ring-1 ring-blue dark:ring-wallpaper': selected == 'total',
      }"
      class="select-none flex-1 flex-row-center gap-unit-half whitespace-nowrap rounded-md px-unit py-unit-half bg-blue dark:bg-wallpaper bg-opacity-20 dark:bg-opacity-20"
      @click="clickable && emit('select', 'total')"
    >
      <op-icon icon="hashtag" />
      {{ i18n.t('_storage_files.total') }}
      {{ loader.total ?? 0 }}
    </div>
  </template>
</template>
