<script setup lang="ts">
/**
 * The questions before acting on a project: deleting it (with exactly what
 * goes when the files go too: what the app downloaded and its «data», never
 * the rest), stopping it, confirming a cleanup above the safety threshold.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatBytes, formatNumber } from '../lib/format'
import * as icons from '../lib/icons'
import { app, confirmDialog } from '../store'
import AppIcon from './ui/AppIcon.vue'
import UiCheck from './ui/UiCheck.vue'
import UiDialog from './ui/UiDialog.vue'

const { t } = useI18n()
const project = computed(() => app.projects.find(p => p.id == app.dialog?.id))
const deleteFiles = ref(false)
watch(
  () => app.dialog,
  () => (deleteFiles.value = false),
)
/** The names the app created there: those in place after the last plan, else what the last run brought */
const created = computed(() => {
  const runtime = project.value?.runtime
  return (
    runtime?.plan?.up_to_date ??
    (runtime?.last_result ? runtime.last_result.downloaded + runtime.last_result.already_present : undefined)
  )
})
/** Their size, as the last plan has it: what On Page has less what was still to download */
const createdBytes = computed(() => {
  const plan = project.value?.runtime.plan
  return plan && formatBytes(Math.max(0, plan.remote_bytes - plan.to_download_bytes))
})
const foreign = computed(() => project.value?.folder_info?.foreign_entries ?? 0)
const cleanup = computed(
  () =>
    project.value?.runtime.issues.find(i => i.code == 'cleanup_needs_confirmation')?.count ??
    project.value?.runtime.plan?.to_remove ??
    0,
)
/** The On Page project the folder is synced with, as the job that stopped found it */
const otherProject = computed(
  () => project.value?.runtime.issues.find(i => i.code == 'folder_other_project')?.detail ?? '',
)
const cancel = (): void => {
  app.dialog = undefined
}
</script>

<template>
  <template v-if="project && app.dialog">
    <UiDialog
      v-if="app.dialog.kind == 'delete'"
      tone="danger"
      :icon="icons.faTrashCan"
      :title="t('delete.title')"
      :text="t('delete.text', { label: project.label })"
      :confirm="t('toolbar.delete')"
      :confirm-icon="icons.faTrashCan"
      @confirm="confirmDialog({ delete_files: deleteFiles })"
      @cancel="cancel"
    >
      <div class="flex flex-col gap-md">
        <UiCheck v-model="deleteFiles">{{ t('delete.files') }}</UiCheck>
        <ul v-if="deleteFiles" class="flex flex-col gap-xs-sm rounded-md bg-neutral-soft p-md text-xs">
          <li class="flex items-start gap-sm">
            <AppIcon :icon="icons.faTrashCan" class="mt-[2px] text-danger-fg" />
            <template v-if="created == null">{{ t('delete.removes_unknown') }}</template>
            <template v-else-if="createdBytes">{{
              t('delete.removes_size', { count: formatNumber(created), size: createdBytes }, created)
            }}</template>
            <template v-else>{{ t('delete.removes', { count: formatNumber(created) }, created) }}</template>
          </li>
          <li class="flex items-start gap-sm">
            <AppIcon :icon="icons.faFolder" class="mt-[2px] text-secondary" />
            {{
              foreign
                ? t('delete.keeps', { count: formatNumber(foreign), folder: project.folder }, foreign)
                : t('delete.keeps_none', { folder: project.folder })
            }}
          </li>
        </ul>
        <p v-else class="text-xs text-secondary">{{ t('delete.keeps_all') }}</p>
      </div>
    </UiDialog>
    <UiDialog
      v-else-if="app.dialog.kind == 'stop'"
      tone="warning"
      :icon="icons.faStop"
      :title="project.runtime.phase == 'downloading' ? t('stop.title_download') : t('stop.title')"
      :text="t('stop.text', { label: project.label })"
      :confirm="t('toolbar.stop')"
      :confirm-icon="icons.faStop"
      @confirm="confirmDialog()"
      @cancel="cancel"
    />
    <UiDialog
      v-else-if="app.dialog.kind == 'take_over'"
      tone="warning"
      :icon="icons.faArrowsRotate"
      :title="t('take_over.title', { label: project.label })"
      :text="t(project.keep_old_files ? 'take_over.text_keep' : 'take_over.text', { other: otherProject })"
      :confirm="t('take_over.confirm')"
      :confirm-icon="icons.faFolderOpen"
      @confirm="confirmDialog()"
      @cancel="cancel"
    />
    <UiDialog
      v-else
      tone="warning"
      :icon="icons.faTrashCan"
      :title="t('cleanup.title', { count: formatNumber(cleanup) })"
      :text="t('cleanup.text')"
      :confirm="t('cleanup.confirm')"
      @confirm="confirmDialog()"
      @cancel="cancel"
    />
  </template>
</template>
