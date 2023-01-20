<script lang="ts" setup>
import { StorageService, SupportedLang, SUPPORTED_LANGS } from '@classes/store'
import { countries } from '../..//boot/countries'
import { computed, watch, onBeforeMount, Ref, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import OpFlag from './op-flag.vue'
import OpToggle from './op-toggle.vue'
const i18n = useI18n()
const props = defineProps({
  storage: {
    type: StorageService,
    required: true,
  },
})
const local_simultaneous_downloads: Ref<number | undefined> = ref(undefined)
const debounce_save: Ref<any | undefined> = ref(undefined)

const current_lang = computed(() => props.storage.user_properties.language)
const simultaneous_downloads = computed(
  () => props.storage.user_properties.simultaneous_downloads,
)
const dark_mode = computed(() => props.storage.user_properties.dark_mode)
function toggleDarkMode(): void {
  props.storage.set('user_properties.dark_mode', !dark_mode.value)
}
function setSimultaneousDownloads(new_val: number): void {
  if (debounce_save.value) {
    clearTimeout(debounce_save.value)
    debounce_save.value = undefined
  }
  debounce_save.value = setTimeout(() => {
    props.storage.set('user_properties.simultaneous_downloads', new_val)
  }, 300)
}
function setLang(lang: SupportedLang): void {
  props.storage.set('user_properties.language', lang)
}

watch(
  simultaneous_downloads,
  val => {
    local_simultaneous_downloads.value = val
  },
  { immediate: true },
)

onBeforeMount(() => {
  if (!simultaneous_downloads.value) {
    setSimultaneousDownloads(1)
  }
  if (!current_lang.value) {
    setLang('it')
  }
})
</script>
<template>
  <div class="full-height-scroll gap-unit-double modal-size-w-sm">
    <h4>{{ i18n.t('user_settings') }}</h4>
    <div class="full-height-scroll gap-unit-double pr-unit-half">
      <OpToggle :model-value="dark_mode" @update:model-value="toggleDarkMode()">
        <span> {{ i18n.t('dark_mode') }}</span>
      </OpToggle>

      <div v-if="local_simultaneous_downloads" class="flex flex-col">
        <span>
          {{ $t('simultaneous_downloads') }}
          <span class="text-sm opacity-50"> ({{ $t('min_1') }}) </span>
        </span>
        <div class="flex flex-row">
          <op-input
            type="number"
            :min="1"
            :max="10"
            required
            :step="1"
            style="max-width: 4rem"
            :model-value="local_simultaneous_downloads"
            @update:model-value="setSimultaneousDownloads($event)"
          />
        </div>
      </div>

      <div class="flex flex-col">
        <div>{{ $t('app_language') }}</div>
        <div class="flex-row-center-unit">
          <op-clickable-tag
            v-for="lang in SUPPORTED_LANGS"
            :key="lang"
            :active="lang == current_lang"
            @click="setLang(lang)"
          >
            <OpFlag :iso="countries[lang]" rounded />
            {{ $t(`language.${lang}`) }}
          </op-clickable-tag>
        </div>
      </div>
    </div>
  </div>
</template>
