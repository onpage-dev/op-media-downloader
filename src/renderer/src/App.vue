<script setup lang="ts">
import { StorageService } from '@classes/store'
import { forEach } from 'lodash'
import { computed, onBeforeMount, Ref, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import OpMenubar from './components/op-menubar.vue'
import StorageDataList from './components/storage-data/storage-data-list.vue'
import { themes } from './service/theme-service'
/** Storage */
const storage = ref(new StorageService()) as Ref<StorageService>

/** Language */
const i18n = useI18n()
const lang = computed(() => storage.value.user_properties.language)
watch(lang, () => {
  i18n.locale.value = lang.value ?? 'it'
})

/** Theme */
const theme = ref(themes[0])
const dark_mode = computed(() => storage.value.user_properties.dark_mode)
const base_style = computed(() => {
  const ret: string[] = []
  const variants = ['', 'focus', 'hover']
  forEach(theme.value?.colors ?? {}, (color_variants, name) => {
    const colors = [] as string[]
    const suffixes = [] as string[]
    forEach(color_variants, (_, color_variant_name: any) => {
      const suffix =
        color_variant_name === 'DEFAULT' ? '' : '-' + color_variant_name
      suffixes.push(suffix)
      colors.push(name + suffix)
    })
    if (name == 'inherit') return
    colors.forEach(n => {
      variants.forEach(variant => {
        const prefix = variant ? variant + '\\:' : ''
        const suffix = variant ? ':' + variant : ''
        const style = suffixes
          .map(
            suffix => `--color-inherit${suffix}: var(--color-${name}${suffix})`,
          )
          .join('; ')
        ret.push(`.${prefix}bg-${n}.provide-bg${suffix} { ${style} }`)
        ret.push(
          `.dark .dark\\:${prefix}bg-${n}.provide-bg${suffix} { ${style} }`,
        )
      })
    })
  })
  return ret.join(' ')
})
function toggleDarkMode(): void {
  const html = document.querySelector('html')!
  if (dark_mode.value) {
    html.classList.add('dark')
    html.classList.remove('light')
  } else {
    html.classList.remove('dark')
    html.classList.add('light')
  }
}
function setBaseColor(
  name: string,
  color: string,
  element?: HTMLElement,
): void {
  if (!element) element = document.documentElement
  element.style.setProperty(`--color-${name}`.replace('-DEFAULT', ''), color)
}
watch(dark_mode, () => toggleDarkMode())
onBeforeMount(() => {
  toggleDarkMode()
  forEach(theme.value.colors, (color, name) => {
    forEach(color, (color, attr) => {
      setBaseColor(name + '-' + attr, color)
    })
  })
})
</script>
<template>
  <div
    id="realapp"
    class="full-height-scroll-wfull h-full bg-wallpaper dark:bg-darkwallpaper provide-bg"
  >
    <component :is="'style'" v-text="base_style" />
    <div class="full-height-scroll-wfull items-center gap-unit">
      <OpMenubar :storage="storage" />
      <StorageDataList :storage="storage" />
    </div>
  </div>
</template>
