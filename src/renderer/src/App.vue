<script setup lang="ts">
import { forEach } from 'lodash'
import { computed, onBeforeMount, Ref, ref, watch } from 'vue'
import { LocalStoreData } from '../classes/store'
import OpMenubar from './components/op-menubar.vue'
import { themes } from './service/theme-service'
import Home from './views/home.vue'

const local_store_data = ref(new LocalStoreData()) as Ref<LocalStoreData>
const theme = ref(themes[1])

const dark_mode = computed(
  () => local_store_data.value.user_properties.dark_mode,
)

const base_style = computed(() => {
  const ret = [] as string[]
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
  element!.style.setProperty(`--color-${name}`.replace('-DEFAULT', ''), color)
}
onBeforeMount(() => {
  toggleDarkMode()
  forEach(theme.value.colors, (color, name) => {
    forEach(color, (color, attr) => {
      setBaseColor(name + '-' + attr, color)
    })
  })
})

watch(dark_mode, () => {
  toggleDarkMode()
})
</script>

<template>
  <div
    id="realapp"
    class="full-height-scroll-wfull relative h-full bg-wallpaper dark:bg-darkwallpaper provide-bg"
  >
    <component :is="'style'" v-text="base_style" />
    <div class="full-height-scroll-wfull gap-unit relative">
      <OpMenubar :local-store-data="local_store_data" />
      <Home :local-store-data="local_store_data" />
    </div>
  </div>
</template>
