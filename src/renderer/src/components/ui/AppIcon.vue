<script setup lang="ts">
/** A Font Awesome icon (light or kit) at the size of the text around it */
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import type { IconDefinition } from '../../lib/icons'

defineProps<{ icon: IconDefinition; spin?: boolean }>()
</script>

<template>
  <FontAwesomeIcon :icon="icon" :spin="spin" class="shrink-0" aria-hidden="true" />
</template>
