<script setup lang="ts">
/**
 * What the inspection of a folder found, a line each in its tone: where it is,
 * whether it can be used, hard links, free space, what is already there. The
 * problems that forbid the folder come first.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FolderInfo } from '@shared/models'
import { formatBytes, formatNumber } from '../lib/format'
import * as icons from '../lib/icons'
import { TONE_FG, TONE_SOFT, toneText } from '../lib/status-view'
import AppIcon from './ui/AppIcon.vue'

const props = defineProps<{ info: FolderInfo; needed?: number }>()
const { t } = useI18n()

type Tone = 'success' | 'info' | 'warning' | 'danger'
interface Line {
  key: string
  tone: Tone
  icon: icons.IconDefinition
  title: string
  text: string
}
const lines = computed(() => {
  const info = props.info
  const result: Line[] = []
  for (const problem of info.problems) {
    result.push({
      key: problem,
      tone: 'danger',
      icon: icons.faCircleExclamation,
      title: t(`check.${problem}.title`),
      text: t(`check.${problem}.text`, { detail: info.problem_detail ?? '' }),
    })
  }
  if (info.problems.length) return result
  const kind = info.kind == 'unknown' ? 'local' : info.kind
  result.push({
    key: 'kind',
    tone: 'info',
    icon: kind == 'network' ? icons.faFolderWireless : kind == 'removable' ? icons.faHardDrive : icons.faFolder,
    title: t(`check.${kind}.title`),
    text: t(`check.${kind}.text`),
  })
  if (!info.exists)
    result.push({
      key: 'missing',
      tone: 'info',
      icon: icons.faFolder,
      title: t('check.missing.title'),
      text: t('check.missing.text'),
    })
  if (info.hardlinks === false)
    result.push({
      key: 'links',
      tone: 'warning',
      icon: icons.faLinkSimpleSlash,
      title: t('check.hardlinks_no.title'),
      text: t('check.hardlinks_no.text'),
    })
  if (info.hardlinks === true)
    result.push({
      key: 'links',
      tone: 'success',
      icon: icons.faLink,
      title: t('check.hardlinks_yes.title'),
      text: t('check.hardlinks_yes.text'),
    })
  if (info.free_bytes != null) {
    const needed = props.needed != null ? props.needed * (info.hardlinks === false ? 2 : 1) : undefined
    const short = needed != null && needed > info.free_bytes
    result.push({
      key: 'free',
      tone: short ? 'danger' : 'success',
      icon: icons.faHardDrive,
      title: t('check.free.title', { free: formatBytes(info.free_bytes) }),
      text: needed != null ? t('check.free.text', { needed: formatBytes(needed) }) : t('check.free.text_unknown'),
    })
  }
  if (info.foreign_entries)
    result.push({
      key: 'foreign',
      tone: 'warning',
      icon: icons.faFolderOpen,
      title: t('check.foreign.title'),
      text: t('check.foreign.text', { count: formatNumber(info.foreign_entries) }, info.foreign_entries),
    })
  return result
})
</script>

<template>
  <ul class="flex flex-col gap-sm">
    <li
      v-for="line in lines"
      :key="line.key"
      class="flex items-start gap-sm-md rounded-md px-md py-sm"
      :class="TONE_SOFT[line.tone]"
    >
      <AppIcon :icon="line.icon" class="mt-[3px]" :class="TONE_FG[line.tone]" />
      <div class="min-w-0" :class="toneText(line.tone)">
        <div class="text-sm font-medium leading-normal">{{ line.title }}</div>
        <div class="text-xs">{{ line.text }}</div>
      </div>
    </li>
  </ul>
</template>
