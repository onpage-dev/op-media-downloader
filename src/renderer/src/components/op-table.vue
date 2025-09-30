<script lang="ts" setup>
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    radius?: string
    tclass?: string
  }>(),
  {
    radius: 'md',
    tclass: '',
  },
)

const table_classes = computed(() => {
  const classes: string[] = [props.tclass]
  if (props.radius) {
    classes.push(`table-round-${props.radius}`)
  }
  return classes.join(' ')
})
</script>
<template>
  <table class="op-table-wrapper" :class="table_classes">
    <slot />
  </table>
</template>
<style lang="scss">
.op-table-wrapper {
  @apply border-collapse border-hidden duration-300;

  // Header
  thead > tr > * {
    @apply bg-inherit-8 dark:bg-inherit-4 overflow-hidden;
    // border: 1px solid transparent;
    padding: 0.5rem 1rem;

    &[hover] {
      @apply cursor-pointer select-none;
    }
  }

  // Footer
  tfoot > tr > * {
    @apply bg-inherit-8 dark:bg-inherit-4 overflow-hidden;
    // border: 1px solid transparent;
    // border-bottom: 0px;
    padding: 0.5rem 1rem;

    &[hover] {
      @apply cursor-pointer;
    }
  }

  tbody > tr[active='true'] > td {
    background: linear-gradient(
        rgba(var(--color-accent), 0.2),
        rgba(var(--color-accent), 0.2)
      ),
      rgba(var(--color-inherit));
  }

  // Body
  tbody > tr > td {
    @apply overflow-hidden;
    border: 1px solid transparent;
    padding: 0.5rem 1rem;

    &:not([custom_color='true']) {
      @apply bg-inherit-6 dark:bg-inherit-6;
    }

    &[active='true'] {
      background: linear-gradient(
          rgba(var(--color-accent), 0.2),
          rgba(var(--color-accent), 0.2)
        ),
        rgba(var(--color-inherit)) !important;
    }

    &[hover='true'] {
      @apply cursor-pointer;
      &:hover {
        @apply brightness-95 dark:brightness-90;
      }
    }
  }

  // Radius class
  &.table-round-md {
    @apply rounded-md;
    > *:first-child > tr:first-child > *:first-of-type {
      @apply rounded-tl-md;
    }
    > *:first-child > tr:first-child > *:last-child {
      @apply rounded-tr-md;
    }
    > *:last-child > tr:last-child > *:first-of-type {
      @apply rounded-bl-md;
    }
    > *:last-child > tr:last-child > *:last-child {
      @apply rounded-br-md;
    }
  }

  // Full width
  &[expanded] {
    @apply w-full;
  }

  // Striped
  &[striped] > tbody > tr {
    &:nth-child(odd) {
      > * {
        &:not([custom_color='true']) {
          @apply bg-inherit-4 dark:bg-inherit-7;
        }
      }
    }
  }
  &[striped] > tbody > tr {
    &:nth-child(even) {
      > * {
        &[custom_color='true'],
        &[active='true'] {
          @apply brightness-95 dark:brightness-90;
        }
      }
    }
  }

  // Hover
  &[hover] > tbody > tr {
    @apply cursor-pointer;
    &:hover {
      @apply brightness-95 dark:brightness-90;
    }
  }

  // Sticky Header
  &[sticky] {
    > thead > tr > th {
      @apply sticky top-0;
      z-index: 4;
    }
  }

  // Sticky Col
  &[sticky-col] {
    > tbody > tr > td:first-of-type {
      @apply sticky left-0;
      z-index: 3;
    }
    > thead > tr > th:first-of-type {
      @apply sticky left-0;
      z-index: 5;
    }
  }

  // Sticky Footer
  &[sticky-footer] {
    > tfoot > tr > * {
      @apply sticky bottom-0;
      z-index: 4;
    }
  }
}
</style>
