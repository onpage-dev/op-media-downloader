import { IpcRendererEvent } from '@electron-toolkit/preload'
import { sleep } from '@renderer/service/utils'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import { cloneDeep, flatMap, throttle, uniqBy } from 'lodash'
import { Api, FieldID, OpFile, OpFileRaw, Schema } from 'onpage-js'
import { reactive } from 'vue'
import { ConfigEvents, StorageService } from './store'
dayjs.extend(utc)

interface SyncResult extends SyncProgressInfo {
  end_time: string
}
export interface CondensedOpFile {
  url: string
  token: string
  name: string
}
export interface SyncProgressInfo {
  start_time: string
  downloading: boolean
  total: number
  downloaded: number
  failed: number
  already_exists: number
}

export interface FolderConfigJson {
  id: string
  label: string
  api_token: string
  folder_path: string
  last_sync?: SyncResult
}
export class FolderConfig {
  api: Api
  schema?: Schema
  loaders: Map<FieldID, boolean> = reactive(new Map())
  current_sync?: SyncProgressInfo

  images_raw: Map<FieldID, readonly OpFileRaw[]> = reactive(new Map())
  images_raw_by_token: Map<string, OpFileRaw[]> = reactive(new Map())
  local_file_tokens: string[] = reactive([])

  constructor(public storage: StorageService, public json: FolderConfigJson) {
    this.api = reactive(new Api('app', this.api_token)) as Api

    void this.refresh()
  }
  get images_raw_array(): OpFileRaw[] {
    return flatMap(Array.from(this.images_raw), ([, val]) => val)
  }
  get images_array(): OpFileRaw[] {
    return flatMap(Array.from(this.images_raw), ([, val]) => val)
  }
  get unique_images_array(): OpFileRaw[] {
    return uniqBy(this.images_array, file => file.name)
  }
  get label(): string {
    return this.json.label
  }
  set label(val: string) {
    this.json.label = val
  }
  get api_token(): string {
    return this.json.api_token
  }
  set api_token(val: string) {
    this.json.api_token = val
  }
  get id(): string {
    return this.json.id
  }
  set id(id: string) {
    this.json.id = id
  }
  get folder_path(): string {
    return this.json.folder_path
  }
  set folder_path(val: string) {
    this.json.folder_path = val
  }
  get last_sync(): SyncResult | undefined {
    return this.json.last_sync
  }
  set last_sync(val: SyncResult | undefined) {
    if (!val) delete this.json.last_sync
    this.json.last_sync = val
  }

  get is_downloading(): boolean {
    return this.current_sync?.downloading ?? false
  }
  get is_loading(): boolean {
    return !!this.loaders.size || this.is_downloading
  }
  getConfig(): FolderConfigJson {
    return {
      id: this.id,
      label: this.label,
      api_token: this.api_token,
      folder_path: this.folder_path,
      last_sync: this.last_sync,
    }
  }
  getCurrentDate(): string {
    return dayjs().format('YYYY-MM-DD HH:mm:ss')
  }
  resetRemoteFiles(): void {
    this.images_raw_by_token.clear()
    this.images_raw.clear()
  }
  // Load all files of the project
  async loadRemoteFiles(): Promise<void> {
    console.log('[loadRemoteFiles] check schema')
    if (!this.schema) return
    this.resetRemoteFiles()
    console.log('[loadRemoteFiles] triggered')

    for (const resource of this.schema.resources) {
      for (const field of resource.fields) {
        if (!field.isMedia()) continue
        this.loaders.set(field.id, true)
        let images: OpFileRaw[] | undefined
        while (!images) {
          try {
            images = await this.schema
              ?.query(resource.name)
              .pluck<OpFile>(field.id)
            break
          } catch (error) {
            await sleep(1000)
          }
        }

        this.images_raw.set(field.id, Object.freeze(images))
        images.forEach(i => {
          const bytoken = this.images_raw_by_token.get(i.token)
          if (!bytoken) this.images_raw_by_token.set(i.token, [i])
          else bytoken.push(i)
        })
        this.loaders.delete(field.id)
      }
    }
  }

  // Download remote missing files
  async syncFiles(): Promise<void> {
    await this.loadRemoteFiles()
    this.downloadFiles()
  }

  setCurrentSyncDebounced = throttle((self: FolderConfig, data: any) => {
    console.log('[downloader] set debounced', data)
    if (!self.current_sync) return
    Object.assign(self.current_sync, data)
  }, 500)

  onDownloadProgress(
    progressEvent: ConfigEvents['downloadProgress']['progressEvent'],
  ): void {
    if (data.config_id != this.id) return

    this.setCurrentSyncDebounced(this, progressEvent)

    if (!progressEvent.downloading) {
      console.log('download ended', data.config_id)

      // Delete local files that are not present on remote anymore
      window.electron.ipcRenderer.send(
        'deleteRemovedFilesFromRemote',
        cloneDeep(this.images_raw_array),
        this.folder_path,
      )

      // Save sync
      this.saveLastSync(progressEvent)
    }
  }

  downloadFiles(): void {
    console.log('[downloader] start')
    if (!this.unique_images_array.length)
      return console.log('[downloader] no images')
    if (this.is_downloading)
      return console.log('[downloader] already downloading')

    this.current_sync = reactive({
      start_time: this.getCurrentDate(),
      downloading: false,
      total: 0,
      downloaded: 0,
      failed: 0,
      already_exists: 0,
    })
    window.electron.ipcRenderer.send(
      'downloadFiles',
      this.id,
      cloneDeep({
        files: this.unique_images_array.map(file => ({
          url: OpFile.fromRaw(file).link(),
          token: file.token,
          name: file.name,
        })),
        directory: this.folder_path,
        loader: this.current_sync,
      }),
    )
  }

  saveLastSync(progress: SyncProgressInfo): void {
    this.last_sync = {
      end_time: this.getCurrentDate(),
      downloaded: progress.downloaded,
      downloading: progress.downloading,
      start_time: progress.start_time,
      failed: progress.failed,
      already_exists: progress.already_exists,
      total: progress.total,
    }
    this.current_sync = undefined
    this.resetRemoteFiles()
    console.log('completed! save last sync')
    this.storage.setConfig(this.getConfig())
  }

  async refresh(): Promise<void> {
    if (!this.schema) {
      this.schema = reactive(await this.api.loadSchema()) as Schema
    }
  }
}
