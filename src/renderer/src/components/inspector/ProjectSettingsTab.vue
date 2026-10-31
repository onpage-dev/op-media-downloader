<script setup lang="ts">
/**
 * «Impostazioni»: the project's settings in place. The token stays masked
 * («Mostra» reveals it); what is typed in the field takes its place and
 * «Verifica» checks the token in the field. The folder changes with the
 * picker and is inspected at once. «Annulla» and «Salva» appear once
 * something changed.
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FolderInfo, ProjectView, TokenCheck } from '@shared/models'
import * as icons from '../../lib/icons'
import { updateProject } from '../../store'
import FolderChecks from '../FolderChecks.vue'
import TokenVerdict from '../TokenVerdict.vue'
import StatusTag from '../ui/StatusTag.vue'
import TextField from '../ui/TextField.vue'
import UiButton from '../ui/UiButton.vue'
import UiCheck from '../ui/UiCheck.vue'

const props = defineProps<{ project: ProjectView }>()
const { t } = useI18n()
const MASK = '•'.repeat(22)

const form = reactive({ label: '', folder: '', keep_old_files: false, token: '' })
/** A token typed in place of the saved one; until then the field shows the saved one, masked or revealed */
const editing = ref(false)
const revealed = ref<string>()
const check = ref<TokenCheck | 'checking'>()
const folderInfo = ref<FolderInfo>()
const saving = ref(false)

function reset(): void {
  Object.assign(form, { label: props.project.label, folder: props.project.folder, keep_old_files: props.project.keep_old_files, token: '' })
  editing.value = false
  revealed.value = undefined
  check.value = undefined
  folderInfo.value = undefined
}
watch(() => props.project.id, reset, { immediate: true })

const dirty = computed(
  () =>
    form.label.trim() != props.project.label ||
    form.folder != props.project.folder ||
    form.keep_old_files != props.project.keep_old_files ||
    (editing.value && !!form.token.trim()),
)
const blocked = computed(
  () => !form.label.trim() || !!folderInfo.value?.problems.length || (editing.value && typeof check.value == 'object' && !check.value.ok),
)

const tokenText = computed(() => (editing.value ? form.token : (revealed.value ?? MASK)))
function typeToken(value: string): void {
  editing.value = true
  form.token = value.replaceAll('•', '')
  check.value = undefined
}
/** On the mask, the first key replaces it all */
function selectMask(event: FocusEvent): void {
  if (!editing.value && revealed.value == null) (event.target as HTMLInputElement).select()
}
async function toggleToken(): Promise<void> {
  revealed.value = revealed.value == null ? await window.desktop.projects.revealToken(props.project.id) : undefined
}
async function verify(): Promise<void> {
  check.value = 'checking'
  const token = editing.value ? form.token.trim() : (revealed.value ?? (await window.desktop.projects.revealToken(props.project.id)))
  check.value = await window.desktop.tokens.verify(token)
}

async function pickFolder(): Promise<void> {
  const picked = await window.desktop.folders.pick(form.folder)
  if (!picked) return
  form.folder = picked
  folderInfo.value = await window.desktop.folders.inspect(picked, props.project.id)
}
/** Without hard links every file is copied: the tag says it beside the folder */
const info = computed(() => folderInfo.value ?? (form.folder == props.project.folder ? props.project.folder_info : undefined))
const copies = computed(() => info.value?.hardlinks === false)

async function save(): Promise<void> {
  saving.value = true
  try {
    await updateProject(props.project.id, {
      label: form.label.trim(),
      folder: form.folder,
      keep_old_files: form.keep_old_files,
      ...(editing.value && form.token.trim() ? { token: form.token.trim() } : {}),
    })
    reset()
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <form class="flex flex-col gap-sm" @submit.prevent="save" @keydown.esc="dirty && reset()">
    <div class="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-x-md gap-y-sm">
      <label for="project-name" class="text-sm text-secondary">{{ t('project.name') }}</label>
      <TextField id="project-name" v-model="form.label" class="max-w-[360px]" />

      <label for="project-token" class="text-sm text-secondary">{{ t('project.token') }}</label>
      <div class="flex items-center gap-md">
        <TextField
          id="project-token"
          :model-value="tokenText"
          class="max-w-[260px]"
          :mono="editing || revealed != null"
          :placeholder="t('wizard.token_placeholder')"
          @update:model-value="typeToken"
          @focus="selectMask"
        />
        <UiButton v-if="!editing" variant="ghost" :icon="revealed == null ? icons.faEye : icons.faEyeSlash" @click="toggleToken">
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
      <template v-if="typeof check == 'object'">
        <span />
        <TokenVerdict :check="check" class="max-w-[560px]" />
      </template>

      <span id="project-folder-label" class="text-sm text-secondary">{{ t('project.folder') }}</span>
      <div class="flex min-w-0 items-center gap-md">
        <button
          id="project-folder"
          v-tooltip="form.folder"
          aria-labelledby="project-folder-label project-folder"
          type="button"
          class="h-[39px] w-full min-w-0 max-w-[260px] truncate rounded-md border border-line bg-box px-sm text-left hover:border-accent-fg"
          @click="pickFolder"
        >
          {{ form.folder }}
        </button>
        <UiButton :icon="icons.faFolderOpen" @click="pickFolder">{{ t('project.change_folder') }}</UiButton>
        <StatusTag
          v-if="copies"
          tone="warning"
          :icon="icons.faTriangleExclamation"
          :label="info?.kind == 'network' ? t('project.copies_network') : t('project.copies')"
        />
      </div>
      <template v-if="folderInfo">
        <span />
        <FolderChecks :info="folderInfo" :needed="project.runtime.plan?.remote_bytes" class="max-w-[560px]" />
      </template>

      <span />
      <UiCheck v-model="form.keep_old_files">{{ t('project.keep') }}</UiCheck>
    </div>
    <div v-if="dirty" class="flex items-center justify-end gap-sm">
      <UiButton :icon="icons.faXmark" @click="reset">{{ t('common.cancel') }}</UiButton>
      <UiButton type="submit" variant="primary" :icon="icons.faFloppyDisk" :disabled="blocked" :loading="saving">{{ t('common.save') }}</UiButton>
    </div>
  </form>
</template>
