<script setup lang="ts">
/** The rows of «Duplicati», a name at a time (see DuplicateGroupRows) */
import type { DuplicateGroup, ProjectId } from '@shared/models'
import DuplicateGroupRows from './DuplicateGroupRows.vue'

defineProps<{ groups: DuplicateGroup[]; projectId: ProjectId }>()
</script>

<template>
  <DuplicateGroupRows v-for="group in groups" :key="group.name" :group="group" :project-id="projectId" />
</template>
