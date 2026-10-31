<script setup lang="ts">
/**
 * The app's settings in five sections, the sections on the left; each change
 * applies at once. Drawn as a window of its own: over the main window on a
 * veil (a dialog named by `titleId`), or alone when main opens `#/settings` in
 * a window. «Aggiornamenti» says what the last check found (or that it could
 * not check, or never did) and links the licenses of the open source parts.
 */
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SettingsSection } from '@shared/desktop-api'
import type { AppSettings, ThemeSetting } from '@shared/models'
import appIcon from '../../assets/app-icon.png'
import * as icons from '../lib/icons'
import { app, checkForUpdates, openLicenses, openRelease, platform, setSettings } from '../store'
import TitleBar from './TitleBar.vue'
import AppIcon from './ui/AppIcon.vue'
import IconButton from './ui/IconButton.vue'
import LangSelect from './ui/LangSelect.vue'
import UiButton from './ui/UiButton.vue'
import UiSegmented from './ui/UiSegmented.vue'
import UiToggle from './ui/UiToggle.vue'

const props = defineProps<{ section: SettingsSection; alone?: boolean; titleId?: string }>()
const emit = defineEmits<{ close: []; section: [SettingsSection] }>()
const { t, te } = useI18n()
/** The words that name the system: Windows, macOS, or the system in general */
const os = platform()
const forOs = (key: string): string => (te(`${key}_${os}`) ? t(`${key}_${os}`) : t(key))
const uid = useId()
const themeTitle = `${uid}-theme`
const languageTitle = `${uid}-language`

const SECTIONS: [SettingsSection, icons.IconDefinition][] = [
  ['general', icons.faGear],
  ['download', icons.faArrowDownToBracket],
  ['appearance', icons.faPalette],
  ['language', icons.faLanguage],
  ['updates', icons.faArrowsRotate],
]
/** Starting with the system does nothing on Linux: not offered there */
const GENERAL = (['open_at_login', 'close_to_tray', 'notifications'] as const).filter(
  key => key != 'open_at_login' || os != 'linux',
)
const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => void setSettings({ [key]: value })
const s = computed(() => app.settings)
const concurrency = computed({
  get: () => String(s.value.concurrency),
  set: value => {
    const n = Math.round(Number(value))
    if (n >= 1 && n <= 10) set('concurrency', n)
  },
})
const themes = computed(() =>
  (['system', 'light', 'dark'] as ThemeSetting[]).map(value => ({ value, label: t(`settings.theme.${value}`) })),
)
const checking = ref(false)
async function checkNow(): Promise<void> {
  checking.value = true
  await checkForUpdates()
  checking.value = false
}
const update = computed(() =>
  app.version?.latest && app.version.latest != app.version.current ? app.version.latest : undefined,
)
/** What the last check found: a new version, none, a check that failed, or no check yet */
const found = computed(() => {
  const version = app.version
  if (update.value) return t('settings.updates.available', { version: bare(update.value) })
  if (version?.check_failed) return t('settings.updates.failed')
  if (!version?.checked_at) return t('settings.updates.never')
  return t('settings.updates.latest')
})
/** «2.0.1» in a sentence, «v2.0.1» on its own */
const bare = (version: string): string => version.replace(/^v/, '')
const v = (version: string): string => `v${bare(version)}`
</script>

<template>
  <div
    class="flex flex-col overflow-hidden bg-mica"
    :class="alone ? 'h-full w-full' : 'h-[540px] w-[760px] max-w-full rounded-md shadow-window'"
  >
    <div class="flex shrink-0 items-center">
      <TitleBar v-if="alone" :title="t('settings.title')" />
      <template v-else>
        <span :id="titleId" class="flex h-8 flex-1 items-center gap-sm pl-md text-xs">
          <img :src="appIcon" class="h-4 w-4" alt="" />
          {{ t('settings.title') }}
        </span>
        <IconButton :icon="icons.faXmark" :label="t('common.close')" :size="32" class="mr-2xs" @click="emit('close')" />
      </template>
    </div>
    <div class="flex min-h-0 flex-1">
      <nav class="flex w-sidebar shrink-0 flex-col gap-2xs p-sm" :aria-label="t('settings.title')">
        <button
          v-for="[item, icon] in SECTIONS"
          :key="item"
          type="button"
          class="flex items-center gap-sm rounded-md px-sm-md py-[9px] text-left text-sm font-medium"
          :class="item == props.section ? 'bg-accent-soft text-accent-fg' : 'hover:bg-tint'"
          :aria-current="item == props.section ? 'page' : undefined"
          :data-autofocus="item == props.section ? '' : undefined"
          @click="emit('section', item)"
        >
          <AppIcon :icon="icon" />
          {{ t(`settings.section.${item}`) }}
        </button>
      </nav>
      <section
        class="flex min-w-0 flex-1 flex-col gap-lg overflow-auto rounded-tl-md border-l border-t border-line bg-box p-xl"
      >
        <h4 class="font-title text-xl font-bold">{{ t(`settings.section.${section}`) }}</h4>
        <div class="flex flex-col divide-y divide-line">
          <template v-if="section == 'general'">
            <div v-for="key in GENERAL" :key="key" class="flex items-center gap-lg py-lg first:pt-0">
              <div class="min-w-0 flex-1">
                <div class="font-medium">{{ forOs(`settings.${key}.title`) }}</div>
                <div class="text-secondary">{{ forOs(`settings.${key}.text`) }}</div>
              </div>
              <UiToggle
                :model-value="s[key]"
                :label="forOs(`settings.${key}.title`)"
                @update:model-value="set(key, $event)"
              />
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
                class="tabular h-control w-16 rounded-md border border-line bg-box px-sm hover:border-accent-fg focus:border-accent-fg focus:shadow-halo"
              />
            </div>
            <div class="flex items-center gap-lg py-lg">
              <div class="min-w-0 flex-1">
                <div class="font-medium">{{ t('settings.auto_retry.title') }}</div>
                <div class="text-secondary">{{ t('settings.auto_retry.text') }}</div>
              </div>
              <UiToggle
                :model-value="s.auto_retry_failed"
                :label="t('settings.auto_retry.title')"
                @update:model-value="set('auto_retry_failed', $event)"
              />
            </div>
          </template>
          <div v-if="section == 'appearance'" class="flex items-center gap-lg py-lg first:pt-0">
            <div class="min-w-0 flex-1">
              <div :id="themeTitle" class="font-medium">{{ t('settings.theme.title') }}</div>
              <div class="text-secondary">{{ forOs('settings.theme.text') }}</div>
            </div>
            <UiSegmented
              :model-value="s.theme"
              :options="themes"
              :aria-labelledby="themeTitle"
              @update:model-value="set('theme', $event)"
            />
          </div>
          <div v-if="section == 'language'" class="flex items-center gap-lg py-lg first:pt-0">
            <div class="min-w-0 flex-1">
              <div :id="languageTitle" class="font-medium">{{ t('settings.language.title') }}</div>
              <div class="text-secondary">{{ t('settings.language.text') }}</div>
            </div>
            <LangSelect
              :model-value="s.language"
              :aria-labelledby="languageTitle"
              @update:model-value="set('language', $event)"
            />
          </div>
          <template v-if="section == 'updates'">
            <div class="flex items-center gap-lg py-lg first:pt-0">
              <div class="min-w-0 flex-1">
                <div class="font-medium">
                  {{ t('settings.updates.version', { version: app.version ? bare(app.version.current) : '' }) }}
                </div>
                <div class="text-secondary" role="status">{{ found }}</div>
              </div>
              <UiButton v-if="update" variant="primary" :icon="icons.faArrowDownToBracket" @click="openRelease">
                {{ t('settings.updates.download', { version: v(update) }) }}
              </UiButton>
              <UiButton v-else :icon="icons.faArrowsRotate" :loading="checking" @click="checkNow">{{
                t('settings.updates.check')
              }}</UiButton>
            </div>
            <div class="flex items-center gap-lg py-lg">
              <div class="min-w-0 flex-1">
                <div class="font-medium">{{ t('settings.updates.check_updates.title') }}</div>
                <div class="text-secondary">{{ t('settings.updates.check_updates.text') }}</div>
              </div>
              <UiToggle
                :model-value="s.check_updates"
                :label="t('settings.updates.check_updates.title')"
                @update:model-value="set('check_updates', $event)"
              />
            </div>
            <div class="py-lg">
              <UiButton variant="link" class="-ml-md" :icon="icons.faArrowUpRightFromSquare" @click="openLicenses">
                {{ t('settings.updates.licenses') }}
              </UiButton>
            </div>
          </template>
        </div>
      </section>
    </div>
  </div>
</template>
