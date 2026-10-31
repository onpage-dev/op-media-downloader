<script setup lang="ts">
/**
 * The app's settings in five sections, the sections on the left; each change
 * applies at once. Drawn as a window of its own: over the main window on a
 * veil, or alone when main opens `#/settings` in a window.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SettingsSection } from '@shared/desktop-api'
import type { AppSettings, ThemeSetting } from '@shared/models'
import appIcon from '../../assets/app-icon.png'
import * as icons from '../lib/icons'
import { app, openRelease, setSettings } from '../store'
import TitleBar from './TitleBar.vue'
import AppIcon from './ui/AppIcon.vue'
import IconButton from './ui/IconButton.vue'
import LangSelect from './ui/LangSelect.vue'
import UiButton from './ui/UiButton.vue'
import UiSegmented from './ui/UiSegmented.vue'
import UiToggle from './ui/UiToggle.vue'

const props = defineProps<{ section: SettingsSection; alone?: boolean }>()
const emit = defineEmits<{ close: []; section: [SettingsSection] }>()
const { t, te } = useI18n()
/** The words that name the system: Windows, macOS, or the system in general */
const os = window.desktop.platform
const forOs = (key: string): string => (te(`${key}_${os}`) ? t(`${key}_${os}`) : t(key))

const SECTIONS: [SettingsSection, icons.IconDefinition][] = [
  ['general', icons.faGear],
  ['download', icons.faArrowDownToBracket],
  ['appearance', icons.faPalette],
  ['language', icons.faLanguage],
  ['updates', icons.faArrowsRotate],
]
const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => void setSettings({ [key]: value })
const s = computed(() => app.settings)
const concurrency = computed({
  get: () => String(s.value.concurrency),
  set: value => {
    const n = Math.round(Number(value))
    if (n >= 1 && n <= 10) set('concurrency', n)
  },
})
const themes = computed(() => (['system', 'light', 'dark'] as ThemeSetting[]).map(value => ({ value, label: t(`settings.theme.${value}`) })))
const checking = ref(false)
async function checkNow(): Promise<void> {
  checking.value = true
  try {
    app.version = await window.desktop.app.checkForUpdates()
  } finally {
    checking.value = false
  }
}
const update = computed(() => (app.version?.latest && app.version.latest != app.version.current ? app.version.latest : undefined))
/** «2.0.1» in a sentence, «v2.0.1» on its own */
const bare = (version: string): string => version.replace(/^v/, '')
const v = (version: string): string => `v${bare(version)}`
</script>

<template>
  <div class="flex flex-col overflow-hidden bg-mica" :class="alone ? 'h-full w-full' : 'h-[540px] w-[760px] max-w-full rounded-md shadow-window'">
    <div class="flex shrink-0 items-center">
      <TitleBar v-if="alone" :title="t('settings.title')" />
      <template v-else>
        <span class="flex h-8 flex-1 items-center gap-sm pl-md text-xs">
          <img :src="appIcon" class="h-4 w-4" alt="" />
          {{ t('settings.title') }}
        </span>
        <IconButton :icon="icons.faXmark" :label="t('common.close')" :size="32" class="mr-2xs" @click="emit('close')" />
      </template>
    </div>
    <div class="flex min-h-0 flex-1">
      <nav class="flex w-[200px] shrink-0 flex-col gap-2xs p-sm">
        <button
          v-for="[section, icon] in SECTIONS"
          :key="section"
          type="button"
          class="flex items-center gap-sm rounded-md px-[10px] py-[9px] text-left text-sm font-medium"
          :class="section == props.section ? 'bg-accent-soft text-accent-fg' : 'hover:bg-text/[.06]'"
          :aria-current="section == props.section ? 'page' : undefined"
          @click="emit('section', section)"
        >
          <AppIcon :icon="icon" />
          {{ t(`settings.section.${section}`) }}
        </button>
      </nav>
      <section class="flex min-w-0 flex-1 flex-col gap-lg overflow-auto rounded-tl-md border-l border-t border-line bg-box p-xl">
        <h4 class="font-title text-xl font-bold">{{ t(`settings.section.${section}`) }}</h4>
        <div class="flex flex-col divide-y divide-line">
          <template v-if="section == 'general'">
            <div v-for="key in ['open_at_login', 'close_to_tray', 'notifications'] as const" :key="key" class="flex items-center gap-lg py-lg first:pt-0">
              <div class="min-w-0 flex-1">
                <div class="font-medium">{{ forOs(`settings.${key}.title`) }}</div>
                <div class="text-secondary">{{ forOs(`settings.${key}.text`) }}</div>
              </div>
              <UiToggle :model-value="s[key]" :label="forOs(`settings.${key}.title`)" @update:model-value="set(key, $event)" />
            </div>
          </template>
          <template v-if="section == 'download'">
            <div class="flex items-center gap-lg py-lg first:pt-0">
              <div class="min-w-0 flex-1">
                <div class="font-medium">{{ t('settings.concurrency.title') }}</div>
                <div class="text-secondary">{{ t('settings.concurrency.text') }}</div>
              </div>
              <input
                v-model.lazy="concurrency"
                type="number"
                min="1"
                max="10"
                :aria-label="t('settings.concurrency.title')"
                class="tabular h-[39px] w-16 rounded-md border border-line bg-box px-sm hover:border-accent-fg focus:border-accent-fg focus:shadow-halo"
              />
            </div>
            <div class="flex items-center gap-lg py-lg">
              <div class="min-w-0 flex-1">
                <div class="font-medium">{{ t('settings.auto_retry.title') }}</div>
                <div class="text-secondary">{{ t('settings.auto_retry.text') }}</div>
              </div>
              <UiToggle :model-value="s.auto_retry_failed" :label="t('settings.auto_retry.title')" @update:model-value="set('auto_retry_failed', $event)" />
            </div>
          </template>
          <div v-if="section == 'appearance'" class="flex items-center gap-lg py-lg first:pt-0">
            <div class="min-w-0 flex-1">
              <div class="font-medium">{{ t('settings.theme.title') }}</div>
              <div class="text-secondary">{{ forOs('settings.theme.text') }}</div>
            </div>
            <UiSegmented :model-value="s.theme" :options="themes" @update:model-value="set('theme', $event)" />
          </div>
          <div v-if="section == 'language'" class="flex items-center gap-lg py-lg first:pt-0">
            <div class="min-w-0 flex-1">
              <div class="font-medium">{{ t('settings.language.title') }}</div>
              <div class="text-secondary">{{ t('settings.language.text') }}</div>
            </div>
            <LangSelect :model-value="s.language" @update:model-value="set('language', $event)" />
          </div>
          <template v-if="section == 'updates'">
            <div class="flex items-center gap-lg py-lg first:pt-0">
              <div class="min-w-0 flex-1">
                <div class="font-medium">{{ t('settings.updates.version', { version: app.version ? bare(app.version.current) : '' }) }}</div>
                <div class="text-secondary">
                  {{ update ? t('settings.updates.available', { version: bare(update) }) : t('settings.updates.latest') }}
                </div>
              </div>
              <UiButton v-if="update" variant="primary" :icon="icons.faArrowDownToBracket" @click="openRelease">
                {{ t('settings.updates.download', { version: v(update) }) }}
              </UiButton>
              <UiButton v-else :icon="icons.faArrowsRotate" :loading="checking" @click="checkNow">{{ t('settings.updates.check') }}</UiButton>
            </div>
            <div class="flex items-center gap-lg py-lg">
              <div class="min-w-0 flex-1">
                <div class="font-medium">{{ t('settings.updates.check_updates.title') }}</div>
                <div class="text-secondary">{{ t('settings.updates.check_updates.text') }}</div>
              </div>
              <UiToggle :model-value="s.check_updates" :label="t('settings.updates.check_updates.title')" @update:model-value="set('check_updates', $event)" />
            </div>
          </template>
        </div>
      </section>
    </div>
  </div>
</template>
