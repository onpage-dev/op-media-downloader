<script setup lang="ts">
/**
 * «Impostazioni»: the project's settings in place. The token stays masked
 * («Mostra» reveals it); what is typed in the field takes its place.
 * «Verifica» checks the token typed, or the saved one (in main, without
 * showing it). The folder changes with the picker and is inspected at once.
 * «Annulla» and «Salva» appear once something changed; after «Salva» the form
 * starts again from what main saved. What fails is said in place.
 */
import { computed, reactive, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ProjectPatch } from '@shared/desktop-api'
import type { ProjectView } from '@shared/models'
import { useAction } from '../../composables/useAction'
import { useFolderField } from '../../composables/useFolderField'
import { useTokenCheck } from '../../composables/useTokenCheck'
import * as icons from '../../lib/icons'
import { TONE_FG, TONE_ICON, TONE_SOFT, toneText } from '../../lib/status-view'
import { revealToken, updateProject } from '../../store'
import FolderChecks from '../FolderChecks.vue'
import TokenVerdict from '../TokenVerdict.vue'
import AppIcon from '../ui/AppIcon.vue'
import FieldError from '../ui/FieldError.vue'
import StatusTag from '../ui/StatusTag.vue'
import TextField from '../ui/TextField.vue'
import UiButton from '../ui/UiButton.vue'
import UiCheck from '../ui/UiCheck.vue'
import UiSpinner from '../ui/UiSpinner.vue'

const props = defineProps<{ project: ProjectView }>()
const { t } = useI18n()
const MASK = '•'.repeat(22)
const uid = useId()
const ids = {
  name: `${uid}-name`,
  token: `${uid}-token`,
  tokenNote: `${uid}-token-note`,
  folderLabel: `${uid}-folder-label`,
  folder: `${uid}-folder`,
  folderNote: `${uid}-folder-note`,
}

const form = reactive({ label: '', keep_old_files: false, token: '' })
/** A token typed in place of the saved one; until then the field shows the saved one, masked or revealed */
const editing = ref(false)
const revealed = ref<string>()
const { check, error: checkError, verify: verifyTyped, verifySaved, reset: resetCheck } = useTokenCheck()
const { folder, info: inspected, error: folderError, pick, reset: resetFolder } = useFolderField(() => props.project.id)
const { run: reveal, busy: revealing, error: revealError, clear: clearReveal } = useAction('reveal token', revealToken)
const {
  run: saveProject,
  busy: saving,
  error: saveError,
  clear: clearSave,
} = useAction('update project', (patch: ProjectPatch) => updateProject(props.project.id, patch))

/** The form from a project: the one shown, or the one main answered with after «Salva» */
function reset(project: ProjectView = props.project): void {
  Object.assign(form, { label: project.label, keep_old_files: project.keep_old_files, token: '' })
  resetFolder(project.folder)
  editing.value = false
  revealed.value = undefined
  resetCheck()
  clearReveal()
  clearSave()
}
// Each project has its own tab (keyed by the inspector): it starts from that project
reset()

const dirty = computed(
  () =>
    form.label.trim() != props.project.label ||
    folder.value != props.project.folder ||
    form.keep_old_files != props.project.keep_old_files ||
    (editing.value && !!form.token.trim()),
)
/** What the folder is known to be: as inspected here, else as main last saw the project's own */
const known = computed(() =>
  typeof inspected.value == 'object'
    ? inspected.value
    : folder.value == props.project.folder
      ? props.project.folder_info
      : undefined,
)
const blocked = computed(
  () =>
    !form.label.trim() ||
    inspected.value == 'inspecting' ||
    (typeof inspected.value == 'object' && !!inspected.value.problems.length) ||
    (editing.value && typeof check.value == 'object' && !check.value.ok),
)
/** Without hard links every file is copied: the tag says it beside the folder */
const copies = computed(() => known.value?.hardlinks === false)
/** The On Page project of a token typed and checked here */
const typedProject = computed(() =>
  editing.value && typeof check.value == 'object' && check.value.ok && check.value.project_id != null
    ? { id: check.value.project_id, label: check.value.project_label ?? '' }
    : undefined,
)
/** The On Page project the folder is for: the typed token's, else the one the project last synced */
const tokenProject = computed(() => typedProject.value ?? props.project.onpage_project)
/** A token of another On Page project: once saved, the folder follows it */
const switching = computed(() => {
  const before = props.project.onpage_project
  const after = typedProject.value
  return before && after && before.id != after.id ? { previous: before.label, project: after.label } : undefined
})
const tokenError = computed(() => checkError.value ?? revealError.value)

const tokenText = computed(() => (editing.value ? form.token : (revealed.value ?? MASK)))
function typeToken(value: string): void {
  editing.value = true
  form.token = value.replaceAll('•', '')
  resetCheck()
}
/** On the mask, the first key replaces it all */
function selectMask(event: FocusEvent): void {
  if (!editing.value && revealed.value == null) (event.target as HTMLInputElement).select()
}
async function toggleToken(): Promise<void> {
  if (revealed.value != null) return void (revealed.value = undefined)
  const token = await reveal(props.project.id)
  if (token != null && !editing.value) revealed.value = token
}
function verify(): void {
  if (editing.value) void verifyTyped(form.token.trim())
  else void verifySaved(props.project.id)
}

async function save(): Promise<void> {
  if (!dirty.value || blocked.value) return
  const saved = await saveProject({
    label: form.label.trim(),
    folder: folder.value,
    keep_old_files: form.keep_old_files,
    ...(editing.value && form.token.trim() ? { token: form.token.trim() } : {}),
  })
  if (saved) reset(saved)
}
</script>

<template>
  <form class="flex flex-col gap-sm" @submit.prevent="save" @keydown.esc="dirty && reset()">
    <div class="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-x-md gap-y-sm">
      <label :for="ids.name" class="text-sm text-secondary">{{ t('project.name') }}</label>
      <TextField :id="ids.name" v-model="form.label" class="max-w-[360px]" />

      <label :for="ids.token" class="text-sm text-secondary">{{ t('project.token') }}</label>
      <div class="flex items-center gap-md">
        <TextField
          :id="ids.token"
          :model-value="tokenText"
          class="max-w-[260px]"
          :mono="editing || revealed != null"
          :placeholder="t('wizard.token_placeholder')"
          :invalid="editing && typeof check == 'object' && !check.ok"
          :aria-describedby="typeof check == 'object' || tokenError ? ids.tokenNote : undefined"
          @update:model-value="typeToken"
          @focus="selectMask"
        />
        <UiButton
          v-if="!editing"
          variant="ghost"
          :icon="revealed == null ? icons.faEye : icons.faEyeSlash"
          :loading="revealing"
          @click="toggleToken"
        >
          {{ revealed == null ? t('project.show') : t('project.hide') }}
        </UiButton>
        <UiButton
          :icon="icons.faCircleCheck"
          :disabled="editing && !form.token.trim()"
          :loading="check == 'checking'"
          @click="verify"
        >
          {{ t('project.verify') }}
        </UiButton>
      </div>
      <template v-if="typeof check == 'object' || tokenError">
        <span />
        <div :id="ids.tokenNote" class="flex max-w-[560px] flex-col gap-sm">
          <TokenVerdict v-if="typeof check == 'object'" :check="check" />
          <FieldError v-else :text="tokenError" />
          <div
            v-if="switching"
            class="flex items-start gap-sm-md rounded-md px-md py-sm text-xs"
            :class="[TONE_SOFT.warning, toneText('warning')]"
          >
            <AppIcon :icon="TONE_ICON.warning" class="mt-[2px]" :class="TONE_FG.warning" />
            <span>{{ t('project.token_other', switching) }}</span>
          </div>
        </div>
      </template>

      <label :id="ids.folderLabel" :for="ids.folder" class="text-sm text-secondary">{{ t('project.folder') }}</label>
      <div class="flex min-w-0 items-center gap-md">
        <button
          :id="ids.folder"
          v-tooltip="folder"
          :aria-labelledby="`${ids.folderLabel} ${ids.folder}`"
          :aria-describedby="inspected || folderError ? ids.folderNote : undefined"
          type="button"
          class="h-control w-full min-w-0 max-w-[260px] truncate rounded-md border border-line bg-box px-sm text-left hover:border-accent-fg"
          @click="pick"
        >
          {{ folder }}
        </button>
        <UiButton :icon="icons.faFolderOpen" @click="pick">{{ t('project.change_folder') }}</UiButton>
        <StatusTag
          v-if="copies"
          tone="warning"
          :icon="icons.faTriangleExclamation"
          :label="known?.kind == 'network' ? t('project.copies_network') : t('project.copies')"
        />
      </div>
      <template v-if="inspected || folderError">
        <span />
        <div :id="ids.folderNote" class="max-w-[560px]">
          <div v-if="inspected == 'inspecting'" class="flex items-center gap-sm text-sm" role="status">
            <UiSpinner class="text-accent-fg" />{{ t('wizard.inspecting') }}
          </div>
          <FolderChecks
            v-else-if="inspected"
            :info="inspected"
            :needed="project.runtime.plan?.remote_bytes"
            :project="tokenProject"
            :keep="form.keep_old_files"
          />
          <FieldError v-else :text="folderError" />
        </div>
      </template>

      <span />
      <UiCheck v-model="form.keep_old_files">{{ t('project.keep') }}</UiCheck>
    </div>
    <div v-if="dirty || saveError" class="flex items-center justify-end gap-sm">
      <FieldError class="min-w-0 flex-1" :text="saveError" />
      <UiButton :icon="icons.faXmark" @click="reset()">{{ t('common.cancel') }}</UiButton>
      <UiButton
        type="submit"
        variant="primary"
        :icon="icons.faFloppyDisk"
        :disabled="blocked || !dirty"
        :loading="saving"
        >{{ t('common.save') }}</UiButton
      >
    </div>
  </form>
</template>
