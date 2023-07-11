<script lang="ts" setup>
import { StorageService } from '@classes/store'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import OpLogo from './op-logo.vue'
import OpModal from './op-modal.vue'
const i18n = useI18n()
const props = defineProps({
  storage: {
    type: StorageService,
    required: true,
  },
})
const show_info = ref(false)
const dark_mode = computed(() => props.storage.user_properties.dark_mode)
const italian = computed(() => i18n.locale.value == 'it')

function openURL(url: string): void {
  window.electron.ipcRenderer.send('openURL', url)
}
</script>

<template>
  <OpModal v-if="show_info" @close="show_info = false">
    <div class="full-height-scroll gap-unit">
      <!-- Title -->
      <h2 class="flex flex-row gap-unit items-start">
        <div class="flex flex-row items-start">
          On Page
          <div class="text-sm mt-unit">®</div>
        </div>
        Media Downloader
      </h2>

      <div class="full-height-scroll gap-unit-double">
        <template v-if="italian">
          <!-- Italian Subtitle -->
          <p>
            Questo programma permette di scaricare tutti i file da un dato
            progetto tramite un
            <span
              class="link"
              @click="
                openURL('https://app.onpage.it/#/help/integrations/token-api')
              "
            >
              Token Api</span
            >.
          </p>

          <!-- Italian Use manual -->
          <div class="flex flex-col gap-unit">
            <h3>Come funziona</h3>

            <p>Per iniziare, aggiungi un nuovo progetto specificando:</p>
            <ol class="pl-unit">
              <li class="flex-row-center-unit">
                <op-icon icon="circle" style="font-size: 0.4rem" /> Nome locale
                per identificare il progetto
              </li>
              <li class="flex-row-center-unit">
                <op-icon icon="circle" style="font-size: 0.4rem" /> Token Api
                del progetto che verrà utilizzato per scaricare i file
              </li>
              <li class="flex-row-center-unit">
                <op-icon icon="circle" style="font-size: 0.4rem" /> Cartella
                dove salvare i file scaricati
              </li>
              <li class="flex-row-center-unit">
                <op-icon icon="circle" style="font-size: 0.4rem" /> Se mantenere
                o meno i vecchi file scaricati non più presenti su On Page
              </li>
            </ol>

            <p class="pt-unit">
              Per ogni progetto potrai effettuare le seguenti azioni:
            </p>
            <ol class="pl-unit">
              <li class="flex-row-center-unit">
                <op-icon icon="circle" style="font-size: 0.4rem" />
                Sincronizzare i file locali con quelli presenti sul progetto
                remoto
              </li>
              <li class="flex-row-center-unit">
                <op-icon icon="circle" style="font-size: 0.4rem" /> Modificare
                le proprietà della configurazione del progetto locale definite
                in fase di creazione
              </li>
              <li class="flex-row-center-unit">
                <op-icon icon="circle" style="font-size: 0.4rem" /> Eliminare il
                progetto locale scegliendo se mantenere o meno i file scaricati
              </li>
            </ol>
          </div>
        </template>
        <template v-else>
          <!-- English Subtitle -->
          <p>
            This program allows to download all files from a given project using
            an
            <span
              class="link"
              @click="
                openURL('https://app.onpage.it/#/help/integrations/token-api')
              "
            >
              API Token</span
            >.
          </p>

          <!-- Italian Use manual -->
          <div class="flex flex-col gap-unit">
            <h3>How it works</h3>

            <p>To start, add a new project setting:</p>
            <ol class="pl-unit">
              <li class="flex-row-center-unit">
                <op-icon icon="circle" style="font-size: 0.4rem" /> Name, used
                as a local identifier of the project
              </li>
              <li class="flex-row-center-unit">
                <op-icon icon="circle" style="font-size: 0.4rem" /> Api Token of
                the remote project that'll be used to download the files
              </li>
              <li class="flex-row-center-unit">
                <op-icon icon="circle" style="font-size: 0.4rem" /> Destination
                Folder where the software will save the downloaded files
              </li>
              <li class="flex-row-center-unit">
                <op-icon icon="circle" style="font-size: 0.4rem" /> If you'd
                like to keep the local files that are not present on On Page
                anymore
              </li>
            </ol>

            <p class="pt-unit">For each project you'll be able to:</p>
            <ol class="pl-unit">
              <li class="flex-row-center-unit">
                <op-icon icon="circle" style="font-size: 0.4rem" />
                Sync the local files with the remote ones
              </li>
              <li class="flex-row-center-unit">
                <op-icon icon="circle" style="font-size: 0.4rem" /> Edit the
                project settings defined during creation
              </li>
              <li class="flex-row-center-unit">
                <op-icon icon="circle" style="font-size: 0.4rem" /> Delete the
                local project and, eventually, the downloaded files too
              </li>
            </ol>
          </div>
        </template>
      </div>

      <div class="flex flex-row gap-unit">
        <op-clickable-tag
          @click="openURL('https://github.com/onpage-dev/op-media-downloader')"
        >
          <op-icon icon="github" type="brand" /> Git
        </op-clickable-tag>
        <op-clickable-tag
          pad="px-unit-double py-0"
          @click="openURL('https://app.onpage.it/#/help')"
        >
          <OpLogo
            :dark="dark_mode"
            class="w-auto object-contain my-unit flex-shrink-0"
            style="height: 0.7rem"
          />
        </op-clickable-tag>
      </div>
    </div>
  </OpModal>
  <div
    class="flex flex-row items-end py-10 cursor-pointer group"
    @click="show_info = true"
  >
    <OpLogo
      :dark="dark_mode"
      class="w-auto object-contain my-unit flex-shrink-0"
      style="height: 4rem"
    />
    <op-icon
      icon="circle-info"
      class="mb-unit group-hover:text-info duration-200"
      style="margin-left: -1rem"
    />
  </div>
</template>
