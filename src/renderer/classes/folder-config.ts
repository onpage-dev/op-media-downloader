import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import { cloneDeep, flatMap, uniqBy } from 'lodash'
import { Emitter } from 'mitt'
import { Api, FieldID, OpFile, OpFileRaw, Resource, Schema } from 'onpage-js'
import { reactive } from 'vue'
import { ConfigEvents, LocalStoreData } from './store'
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
  sync_loader?: SyncProgressInfo

  images_raw: Map<FieldID, OpFileRaw[]> = reactive(new Map())
  images: Map<FieldID, OpFile[]> = reactive(new Map())
  local_file_tokens: string[] = reactive([])

  constructor(
    public local_store_data: LocalStoreData,
    public json: FolderConfigJson,
    public bus: Emitter<any>,
  ) {
    this.api = reactive(new Api('app', this.api_token)) as Api

    // On Progress
    this.bus.on('downloadProgress', this.onDownloadProgress)

    void this.refresh()
  }
  get images_raw_array(): OpFileRaw[] {
    return flatMap(Array.from(this.images_raw), ([, val]) => val)
  }
  get images_array(): OpFile[] {
    return flatMap(Array.from(this.images), ([, val]) => val)
  }
  get unique_images_array(): OpFile[] {
    return uniqBy(this.images_array, (file: OpFile) => file.token)
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
    return this.sync_loader?.downloading ?? false
  }
  get is_loading(): boolean {
    return (
      Array.from(this.loaders.values()).includes(true) || this.is_downloading
    )
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
  resetSyncLoader(): void {
    this.sync_loader = {
      start_time: this.getCurrentDate(),
      downloading: true,
      total: 0,
      downloaded: 0,
      failed: 0,
      already_exists: 0,
    }
  }

  // Load all files of the project
  async loadRemoteFiles(): Promise<void> {
    if (!this.schema) return

    try {
      console.log('[loadRemoteFiles] triggered')

      this.schema.resources.forEach((resource: Resource) => {
        resource.fields.forEach(async field => {
          if (field.isMedia()) {
            this.loaders.set(field.id, true)
            const images = (await this.schema
              ?.query(resource.name)
              .pluck(field.id)) as OpFileRaw[]

            if (images?.length) {
              this.images_raw.set(field.id, images)
              this.images.set(
                field.id,
                images.map(image => new OpFile(this.api, image)),
              )
            }
            this.loaders.set(field.id, false)
          }
        })
      })
    } catch (e) {
      console.log(e)
    }
  }

  // Download remote missing files
  // finally update the index inside local_store_data
  syncFiles(): void {
    this.resetSyncLoader()
    this.downloadFiles()
  }

  onDownloadProgress(data: ConfigEvents['downloadProgress']): void {
    if (data.config_id != this.id) return
    this.sync_loader = data.progressEvent

    if (data.is_complete) {
      console.log('download ended', data.config_id)
      this.sync_loader.downloading = false

      // Delete local files that are not present on remote anymore
      window.electron.ipcRenderer.send(
        'deleteRemovedFilesFromRemote',
        cloneDeep(this.images_raw_array),
        this.folder_path,
      )

      // Save sync
      this.saveLastSync(data.progressEvent)
    }
  }

  // removeEventListeners(): void {
  //   this.bus.off('downloadProgress', this.onDownloadProgress)
  // }

  downloadFiles(): void {
    if (!this.unique_images_array.length) return

    window.electron.ipcRenderer.send(
      'downloadFiles',
      this.id,
      cloneDeep({
        files: this.unique_images_array.map(file => ({
          url: file.link(),
          token: file.token,
          name: file.name,
        })),
        directory: this.folder_path,
        loader: this.sync_loader,
      }),
    )
  }

  saveLastSync(progress: SyncProgressInfo): void {
    const info: SyncResult = {
      end_time: this.getCurrentDate(),
      downloaded: progress.downloaded,
      downloading: progress.downloading,
      start_time: progress.start_time,
      failed: progress.failed,
      already_exists: progress.already_exists,
      total: progress.total,
    }

    const config = this.getConfig()
    config.last_sync = info
    this.local_store_data.setConfig(config).then(() => this.loadLocalFiles())
  }

  // Gets all the tokens that are downloaded inside folder path
  loadLocalFiles(): void {
    window.electron.ipcRenderer.send('loadFiles', this.folder_path)

    window.electron.ipcRenderer.on('loadedFiles', (_event, files) => {
      this.local_file_tokens.splice(0, this.local_file_tokens.length, ...files)
      window.electron.ipcRenderer.removeAllListeners('loadedFiles')
    })
  }
  async refresh(): Promise<void> {
    if (!this.schema) {
      this.schema = reactive(await this.api.loadSchema()) as Schema
    }
    this.loadLocalFiles()
  }
}
