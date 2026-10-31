<script setup lang="ts">
/**
 * A new project in three steps: the token, checked while it is pasted (the
 * On Page project and how many collections have files); the folder, inspected
 * as soon as it is picked (network, hard links, free space, what is already
 * there; a protected or used folder stops here); the options, with «Sincronizza
 * appena creato». A folder dropped on the window arrives already chosen.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FolderInfo, TokenCheck } from '@shared/models'
import * as icons from '../lib/icons'
import { app, createProject } from '../store'
import FolderChecks from './FolderChecks.vue'
import TokenVerdict from './TokenVerdict.vue'
import FormItem from './ui/FormItem.vue'
import TextField from './ui/TextField.vue'
import UiButton from './ui/UiButton.vue'
import UiCheck from './ui/UiCheck.vue'
import UiModal from './ui/UiModal.vue'
import UiSpinner from './ui/UiSpinner.vue'
import UiStepper from './ui/UiStepper.vue'

const props = defineProps<{ folder?: string; step?: number; token?: string }>()
const { t } = useI18n()

const step = ref(props.step ?? 0)
const token = ref(props.token ?? '')
const check = ref<TokenCheck | 'checking'>()
const folder = ref(props.folder ?? '')
const info = ref<FolderInfo | 'inspecting'>()
const label = ref('')
const keep = ref(false)
const syncNow = ref(true)
const creating = ref(false)
const failure = ref('')

let timer: ReturnType<typeof setTimeout> | undefined
/** The name the check proposed: it follows the token until the user writes another */
let proposed = ''
async function verify(): Promise<void> {
  const value = token.value.trim()
  if (!value) return void (check.value = undefined)
  check.value = 'checking'
  const result = await window.desktop.tokens.verify(value)
  if (token.value.trim() != value) return
  check.value = result
  if (result.ok && result.project_label && (!label.value.trim() || label.value == proposed)) label.value = proposed = result.project_label
}
watch(token, () => {
  clearTimeout(timer)
  check.value = undefined
  timer = setTimeout(verify, 500)
})
async function inspect(path: string): Promise<void> {
  info.value = 'inspecting'
  const result = await window.desktop.folders.inspect(path)
  if (folder.value == path) info.value = result
}
async function pick(): Promise<void> {
  const picked = await window.desktop.folders.pick(folder.value || undefined)
  if (!picked) return
  folder.value = picked
  await inspect(picked)
}
onMounted(() => {
  if (folder.value) void inspect(folder.value)
  if (token.value) void verify()
})

const tokenOk = computed(() => typeof check.value == 'object' && check.value.ok)
const folderOk = computed(() => typeof info.value == 'object' && !info.value.problems.length)
const canNext = computed(() => [tokenOk.value, folderOk.value, !!label.value.trim()][step.value])
const done = computed(() => (folderOk.value && step.value < 1 ? [1] : []))

function next(): void {
  if (!canNext.value) return
  if (step.value == 2) return void create()
  step.value++
}
async function create(): Promise<void> {
  creating.value = true
  failure.value = ''
  try {
    await createProject({ label: label.value.trim(), token: token.value.trim(), folder: folder.value, keep_old_files: keep.value, sync_now: syncNow.value })
  } catch (error) {
    failure.value = String(error)
  } finally {
    creating.value = false
  }
}
const close = (): void => {
  app.wizard = undefined
}
</script>

<template>
  <UiModal size="m" :title="t('wizard.title')" @close="close">
    <form id="new-project" class="flex flex-col gap-lg" @submit.prevent="next">
      <UiStepper :steps="[t('wizard.step.token'), t('wizard.step.folder'), t('wizard.step.options')]" :current="step" :done="done" />

      <template v-if="step == 0">
        <FormItem :label="t('project.token')" required :note="t('project.token_note')">
          <TextField v-model="token" mono :placeholder="t('wizard.token_placeholder')" :invalid="typeof check == 'object' && !check.ok" />
        </FormItem>
        <div v-if="check == 'checking'" class="flex items-center gap-sm text-sm"><UiSpinner class="text-accent-fg" />{{ t('wizard.checking') }}</div>
        <TokenVerdict v-else-if="check" :check="check" />
      </template>

      <template v-if="step == 1">
        <FormItem :label="t('project.folder')" required>
          <div class="flex">
            <button
              v-tooltip="folder || undefined"
              type="button"
              class="h-[39px] min-w-0 flex-1 truncate rounded-l-md border border-line bg-box px-sm text-left hover:z-10 hover:border-accent-fg"
              :class="folder ? '' : 'text-placeholder'"
              @click="pick"
            >
              {{ folder || t('wizard.folder_placeholder') }}
            </button>
            <UiButton :icon="icons.faFolderOpen" class="-ml-px rounded-l-none" @click="pick">{{ t('wizard.pick') }}</UiButton>
          </div>
        </FormItem>
        <div v-if="info == 'inspecting'" class="flex items-center gap-sm text-sm"><UiSpinner class="text-accent-fg" />{{ t('wizard.inspecting') }}</div>
        <FolderChecks v-else-if="info" :info="info" />
      </template>

      <template v-if="step == 2">
        <FormItem :label="t('project.name')" required :note="t('wizard.name_note')">
          <TextField v-model="label" />
        </FormItem>
        <UiCheck v-model="keep">{{ t('project.keep') }}</UiCheck>
        <UiCheck v-model="syncNow">{{ t('wizard.sync_now') }}</UiCheck>
        <p v-if="failure" class="text-xs text-danger-fg">{{ failure }}</p>
      </template>
    </form>
    <template #footer>
      <UiButton v-if="step == 0" variant="ghost" :icon="icons.faXmark" @click="close">{{ t('common.cancel') }}</UiButton>
      <UiButton v-else variant="ghost" :icon="icons.faArrowLeft" @click="step--">{{ t('wizard.back') }}</UiButton>
      <span class="flex-1" />
      <UiButton
        type="submit"
        form="new-project"
        variant="primary"
        :icon="step == 2 ? icons.faPlus : icons.faArrowRight"
        :disabled="!canNext"
        :loading="creating"
      >
        {{ step == 2 ? t('wizard.create') : t('wizard.next') }}
      </UiButton>
    </template>
  </UiModal>
</template>
