<script setup lang="ts">
/**
 * «Falliti»: each file with why it failed and how many times it was tried;
 * «Riprova i falliti» on top. When the network goes down halfway they can
 * be tens of thousands: they come a page at a time while scrolling.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ProjectView } from '@shared/models'
import { formatNumber } from '../../lib/format'
import * as icons from '../../lib/icons'
import { app, loadMore, reloadList, retryFailed } from '../../store'
import UiButton from '../ui/UiButton.vue'
import FailedRows from './FailedRows.vue'
import LongList from './LongList.vue'

const props = defineProps<{ project: ProjectView }>()
const { t } = useI18n()
const list = computed(() => app.failed[props.project.id])
const total = computed(() => list.value?.total ?? 0)
</script>

<template>
  <div class="flex flex-col gap-md">
    <div class="flex items-center gap-sm">
      <span class="text-sm font-medium">
        {{
          t(
            project.runtime.phase == 'idle' ? 'failed.summary' : 'failed.summary_running',
            { count: formatNumber(total) },
            total,
          )
        }}
      </span>
      <span class="flex-1" />
      <UiButton
        :icon="icons.faArrowsRotate"
        :disabled="!total || project.runtime.phase != 'idle'"
        @click="retryFailed(project.id)"
      >
        {{ t('failed.retry_all') }}
      </UiButton>
    </div>
    <LongList
      v-slot="{ items }"
      :list="list"
      :empty="t('failed.empty')"
      @more="loadMore('failed', project.id)"
      @retry="reloadList('failed', project.id)"
    >
      <FailedRows :entries="items" />
    </LongList>
  </div>
</template>
