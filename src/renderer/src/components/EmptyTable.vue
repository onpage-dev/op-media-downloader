<script setup lang="ts">
/** No project yet: OpDropZone's area, a folder dropped here starts a new project, and «Nuovo progetto» */
import { useI18n } from 'vue-i18n'
import * as icons from '../lib/icons'
import { openWizard } from '../store'
import AppIcon from './ui/AppIcon.vue'
import UiButton from './ui/UiButton.vue'

defineProps<{ over?: boolean }>()
const { t } = useI18n()
</script>

<template>
  <div class="flex min-h-0 flex-1 p-xl">
    <div
      class="flex flex-1 flex-col items-center justify-center gap-md rounded-xl border border-dashed p-2xl text-center"
      :class="over ? 'border-accent-fg bg-accent-soft' : 'border-line bg-box'"
    >
      <AppIcon :icon="over ? icons.faFolderOpen : icons.faArrowDownToBracket" class="text-[27px] text-accent-fg" />
      <h2 class="font-title text-xl font-bold" :class="over ? 'text-accent-fg' : ''">
        {{ over ? t('empty.drop_title') : t('empty.title') }}
      </h2>
      <p class="max-w-[65ch] text-secondary" :class="over ? 'text-base' : 'text-lg'">
        {{ over ? t('empty.drop_text') : t('empty.text') }}
      </p>
      <UiButton v-if="!over" variant="primary" :icon="icons.faPlus" @click="openWizard()">{{
        t('toolbar.new')
      }}</UiButton>
    </div>
  </div>
</template>
