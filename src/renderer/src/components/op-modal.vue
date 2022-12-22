<script lang="ts" setup>
import { id } from '@renderer/service/utils'
import {
  computed,
  onBeforeMount,
  onBeforeUnmount,
  PropType,
  reactive,
  ref,
  Ref,
} from 'vue'
export type ModalOptions = Partial<{
  props: any
  events: any
  card: any
  plain: boolean
  fullscreen: boolean
  manualclose: boolean
  nobuttons: boolean
  close_handler?: CallableFunction
}>
export type ModalButton = {
  icon: string
  tooltip: string
  action: CallableFunction
}

const emit = defineEmits(['close'])
const props = defineProps({
  opt: {
    type: Object as PropType<ModalOptions>,
    default: () => reactive({}),
  },
})

const buttons: Ref<ModalButton[]> = ref([])
const content_classes = computed((): string => {
  const res: string[] = ['op-modal-content']
  if (props.opt.plain) {
    if (props.opt.fullscreen) {
      res.concat(['overlay', 'flex-col'])
      if (!props.opt.nobuttons) {
        res.push('mt-12')
      }
    }
  }
  return res.join(' ')
})

function handleKeyEvent(e: KeyboardEvent): void {
  if (e.key.toLocaleLowerCase() == 'escape') {
    emit('close')
  }
}

onBeforeMount(() => window.addEventListener('keydown', handleKeyEvent))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeyEvent)
  props.opt.close_handler && props.opt.close_handler()
})
</script>
<template>
  <div class="overlay full-height-scroll-wfull items-center z-50">
    <div
      :style="{
        maxHeight: opt.fullscreen ? '100%' : '92%',
        maxWidth: opt.fullscreen ? '100%' : '92%',
      }"
      class="animate-fadein-slow flex-col op-modal"
      style="min-height: 90vh"
      :class="{
        'm-unit justify-center': !opt.fullscreen,
        'overflow-auto overlay flex-col flex-stretch bg-wallpaper dark:bg-darkwallpaper provide-bg':
          opt.fullscreen,
      }"
    >
      <!-- This is so the main content does not touch the top of the screen -->
      <div v-if="!opt.fullscreen" class="pb-unit" />

      <!-- The action buttons row (close etc.) -->
      <div
        v-if="!opt.nobuttons"
        id="modal-buttons"
        class="flex-row gap-3 justify-end pb-unit"
        :class="{
          'absolute top-0 right-5': opt.fullscreen,
        }"
      >
        <op-circle-btn
          v-for="btn in buttons.concat([
            {
              icon: 'op-close',
              tooltip: $t('close'),
              action: () => $emit('close'),
            },
          ])"
          :key="id(btn)"
          v-handled
          v-tooltip.top="btn.tooltip"
          position="relative"
          :shadow="opt.fullscreen ? 'none' : 'md'"
          :class="opt.fullscreen && 'z-20'"
          @click="btn.action"
        >
          <op-icon :icon="btn.icon" class="text-2xl" />
        </op-circle-btn>
      </div>

      <!-- The main content -->
      <div
        v-if="opt.plain"
        v-handled
        class="full-height-scroll"
        :class="content_classes"
      >
        <slot />
      </div>

      <!-- The main content inside a card -->
      <op-overlay-card
        v-else
        v-handled
        class="overflow-auto"
        :class="content_classes"
        col
      >
        <slot />
      </op-overlay-card>

      <!-- This is so the main content does not touch the bottom of the screen -->
      <div v-if="!opt.fullscreen" class="pb-unit" />
    </div>
  </div>
</template>
