<script setup lang="ts">
import { FolderConfig } from '@classes/folder-config'
import { bytesToString } from '@renderer/helpers'
import { groupBy } from 'lodash'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import OpSearch from '../op-search.vue'

const i18n = useI18n()
const props = defineProps<{
  config: FolderConfig
}>()

const search_q = ref('')
const duplicated_files = computed(() => {
  return new Map(
    Array.from(props.config.duplicated_files).filter(([name]) =>
      name.toLocaleLowerCase().includes(search_q.value.toLocaleLowerCase()),
    ),
  )
})
</script>
<template>
  <div class="modal-size-w-md full-height-scroll gap-unit-double">
    <div class="full-height-scroll gap-unit-double">
      <h4 class="flex-row-center-unit">
        <op-icon
          icon="triangle-exclamation"
          size="xl"
          class="text-warning mr-unit"
        />
        <div>
          {{
            i18n.t('_storage_data.config_has_duplicates', {
              config: config.label,
            })
          }}
        </div>
      </h4>
      <div class="flex-row-center-unit">
        <div
          class="text-sm font-normal px-unit py-unit-half rounded-md bg-orange bg-opacity-20"
        >
          {{ i18n.t('_storage_data.config_has_duplicates_description') }}
        </div>
        <OpSearch v-model="search_q" />
      </div>

      <div class="full-height-scroll gap-unit-double pr-unit-half">
        <div
          v-if="!duplicated_files.size"
          class="flex-col-center opacity-20 p-20 text-3xl"
        >
          {{ $t('no_result') }}
        </div>
        <div
          v-for="[name, val] in duplicated_files"
          :key="name"
          class="flex flex-col gap-unit-half"
        >
          <b>
            {{ name }}
          </b>
          <op-card v-for="[token, value] in val" :key="token" pad="compact" row>
            <a :href="value[0].file.link({ inline: true })" target="_blank">
              <img
                class="w-20 h-20 bg-grey block"
                :src="value[0].file.link({ x: 100, y: 100, mode: 'contain' })"
              />
            </a>

            <div>
              <div
                v-for="duplicates in groupBy(value, x => x.field.id)"
                :key="duplicates[0].field.id"
              >
                <div class="font-bold">
                  {{
                    duplicates[0].field.resource().getLabel(i18n.locale.value)
                  }}
                  →
                  {{ duplicates[0].field.getLabel(i18n.locale.value) }}
                </div>

                <a
                  v-for="x in duplicates"
                  :key="x.thing_id"
                  class="block sober-link-accent"
                  :href="`https://app.onpage.it/#/things/edit/${x.thing_id}/${
                    x.field.schema().id
                  }/${x.field.resource_id}/${x.field.id}`"
                  target="_blank"
                >
                  {{ x.thing_label }}
                  <span class="text-sm opacity-50"> #{{ x.thing_id }} </span>
                  <span v-if="x.lang"> ({{ x.lang }}) </span>
                  <div class="text-sm opacity-50">
                    {{
                      `${x.file.width}x${x.file.height} (${bytesToString(
                        x.file.size,
                      )})`
                    }}
                  </div>
                </a>
              </div>
            </div>
          </op-card>
        </div>
      </div>
    </div>
    <div class="flex-row-center-unit justify-between">
      <op-btn @click="config.loadRemoteFiles()">
        <op-icon icon="arrows-rotate" />
        {{ $t('refresh') }}
      </op-btn>

      <op-btn
        v-tooltip="i18n.t('_storage_data.config_has_duplicates_description_2')"
        color="warning"
        @click="config.confirmDuplicatesAndContinue()"
      >
        <op-icon icon="circle-info" />
        {{ $t('continue') }}
        <op-icon icon="arrow-right" />
      </op-btn>
    </div>
  </div>
</template>
