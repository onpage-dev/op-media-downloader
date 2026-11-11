<script setup lang="ts" generic="T">
/**
 * A long list of the inspector (failed files, duplicate names) a page at a
 * time: the rows in their box (the slot, given the items), the next page as
 * the end comes near, and below them the wait, the error with «Riprova» or the
 * words for an empty list. It takes the list itself, not the project: the
 * states main pushes during a sync do not draw the rows again.
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInfiniteScroll } from '../../composables/useInfiniteScroll'
import * as icons from '../../lib/icons'
import type { PagedList } from '../../store'
import UiButton from '../ui/UiButton.vue'
import UiSpinner from '../ui/UiSpinner.vue'

const props = defineProps<{ list: PagedList<T> | undefined; empty: string }>()
const emit = defineEmits<{ more: []; retry: [] }>()
defineSlots<{ default(props: { items: T[] }): unknown }>()
const { t } = useI18n()

/**
 * The rows come once the tab itself is on screen: a click on the tab never
 * waits for them. A window that draws no frame (hidden) gets them shortly anyway
 */
const painted = ref(false)
onMounted(() => {
  const show = (): void => void (painted.value = true)
  requestAnimationFrame(() => setTimeout(show))
  setTimeout(show, 100)
})

const end = ref<HTMLElement>()
useInfiniteScroll(
  end,
  () => emit('more'),
  () => props.list?.items.length ?? 0,
)
</script>

<template>
  <ul v-if="painted && list?.items.length" class="overflow-hidden rounded-md border border-line bg-box">
    <slot :items="list.items" />
  </ul>
  <div
    v-if="!painted || !list || list.loading"
    class="flex items-center justify-center gap-sm py-lg text-secondary"
    role="status"
  >
    <UiSpinner />
    {{ t('common.loading') }}
  </div>
  <div v-else-if="list.error" class="flex flex-col items-center gap-sm py-xl text-secondary" role="alert">
    {{ t('common.load_error') }}
    <UiButton :icon="icons.faArrowsRotate" @click="emit('retry')">{{ t('common.retry') }}</UiButton>
  </div>
  <p v-else-if="!list.items.length" class="py-xl text-center text-secondary">{{ empty }}</p>
  <div ref="end" class="h-px shrink-0" />
</template>
