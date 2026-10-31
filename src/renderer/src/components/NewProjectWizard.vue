<script setup lang="ts">
/**
 * A new project in three steps: the token, checked while it is pasted (the
 * On Page project and how many collections have files); the folder, inspected
 * as soon as it is picked (network, hard links, free space, what is already
 * there; a protected or used folder stops here); the options, with «Sincronizza
 * appena creato». A folder dropped on the window arrives already chosen. The
 * focus is on the field of each step (Ctrl+N, then Ctrl+V pastes the token);
 * what fails is said in place, in words.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAction } from '../composables/useAction'
import { useFolderField } from '../composables/useFolderField'
import { useTokenCheck } from '../composables/useTokenCheck'
import * as icons from '../lib/icons'
import { app, createProject } from '../store'
import FolderChecks from './FolderChecks.vue'
import TokenVerdict from './TokenVerdict.vue'
import FieldError from './ui/FieldError.vue'
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
const label = ref('')
const keep = ref(false)
const syncNow = ref(true)
const form = ref<HTMLFormElement>()
const { check, error: checkError, verify, verifyLater } = useTokenCheck()
const { folder: path, info, error: folderError, pick, inspect } = useFolderField()
const { run: create, busy: creating, error: createError } = useAction('create project', createProject)
path.value = props.folder ?? ''

/** The name the check proposed: it follows the token until the user writes another */
let proposed = ''
watch(token, value => verifyLater(value.trim()))
watch(check, result => {
  if (typeof result != 'object' || !result.ok || !result.project_label) return
  if (!label.value.trim() || label.value == proposed) label.value = proposed = result.project_label
})
onMounted(() => {
  if (path.value) void inspect(path.value)
  if (token.value.trim()) void verify(token.value.trim())
})
// Each step puts the focus on its field
watch(step, async () => {
  await nextTick()
  form.value?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
})

const tokenOk = computed(() => typeof check.value == 'object' && check.value.ok)
/** The On Page project of the token: the folder check says when the folder is another one's */
const tokenProject = computed(() =>
  typeof check.value == 'object' && check.value.ok && check.value.project_id != null
    ? { id: check.value.project_id, label: check.value.project_label ?? '' }
    : undefined,
)
const folderOk = computed(() => typeof info.value == 'object' && !info.value.problems.length)
const canNext = computed(() => [tokenOk.value, folderOk.value, !!label.value.trim()][step.value])
const done = computed(() => (folderOk.value && step.value < 1 ? [1] : []))

function next(): void {
  if (!canNext.value) return
  if (step.value == 2) {
    void create({
      label: label.value.trim(),
      token: token.value.trim(),
      folder: path.value,
      keep_old_files: keep.value,
      sync_now: syncNow.value,
    })
    return
  }
  step.value++
}
const close = (): void => {
  app.wizard = undefined
}
</script>

<template>
  <UiModal size="m" :title="t('wizard.title')" @close="close">
    <form id="new-project" ref="form" class="flex flex-col gap-lg" @submit.prevent="next">
      <UiStepper
        :steps="[t('wizard.step.token'), t('wizard.step.folder'), t('wizard.step.options')]"
        :current="step"
        :done="done"
      />

      <template v-if="step == 0">
        <FormItem v-slot="{ id, describedby }" :label="t('project.token')" required :note="t('project.token_note')">
          <TextField
            :id="id"
            v-model="token"
            data-autofocus
            mono
            aria-required="true"
            :aria-describedby="describedby"
            :placeholder="t('wizard.token_placeholder')"
            :invalid="typeof check == 'object' && !check.ok"
          />
        </FormItem>
        <div v-if="check == 'checking'" class="flex items-center gap-sm text-sm" role="status">
          <UiSpinner class="text-accent-fg" />{{ t('wizard.checking') }}
        </div>
        <TokenVerdict v-else-if="check" :check="check" />
        <FieldError v-else :text="checkError" />
      </template>

      <template v-if="step == 1">
        <FormItem v-slot="{ id, labelId }" :label="t('project.folder')" required>
          <div class="flex">
            <button
              :id="id"
              v-tooltip="path || undefined"
              data-autofocus
              type="button"
              :aria-labelledby="`${labelId} ${id}`"
              class="h-control min-w-0 flex-1 truncate rounded-l-md border border-line bg-box px-sm text-left hover:z-10 hover:border-accent-fg"
              :class="path ? '' : 'text-placeholder'"
              @click="pick"
            >
              {{ path || t('wizard.folder_placeholder') }}
            </button>
            <UiButton :icon="icons.faFolderOpen" class="-ml-px rounded-l-none" @click="pick">{{
              t('wizard.pick')
            }}</UiButton>
          </div>
        </FormItem>
        <div v-if="info == 'inspecting'" class="flex items-center gap-sm text-sm" role="status">
          <UiSpinner class="text-accent-fg" />{{ t('wizard.inspecting') }}
        </div>
        <FolderChecks v-else-if="info" :info="info" :project="tokenProject" :keep="keep" />
        <FieldError v-else :text="folderError" />
      </template>

      <template v-if="step == 2">
        <FormItem v-slot="{ id, describedby }" :label="t('project.name')" required :note="t('wizard.name_note')">
          <TextField :id="id" v-model="label" data-autofocus aria-required="true" :aria-describedby="describedby" />
        </FormItem>
        <UiCheck v-model="keep">{{ t('project.keep') }}</UiCheck>
        <UiCheck v-model="syncNow">{{ t('wizard.sync_now') }}</UiCheck>
        <FieldError :text="createError" />
      </template>
    </form>
    <template #footer>
      <UiButton v-if="step == 0" variant="ghost" :icon="icons.faXmark" @click="close">{{
        t('common.cancel')
      }}</UiButton>
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
