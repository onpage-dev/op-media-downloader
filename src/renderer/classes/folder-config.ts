import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import { chunk, cloneDeep, flatMap, throttle, uniqBy } from 'lodash'
import {
  Api,
  Field,
  FieldID,
  OpFile,
  OpFileRaw,
  Schema,
  ThingID,
} from 'onpage-js'
import { reactive, watch } from 'vue'
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
  is_stopping: boolean
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
  keep_old_files: boolean
  last_sync?: SyncResult
}
export type FileToken = string
export type FileName = string
export type DuplicatedInfo = {
  field: Field
  thing_id: ThingID
  thing_label?: string
  file: OpFile
  lang?: string
}
export class FolderConfig {
  api: Api
  schema?: Schema
  loading_schema: boolean = false
  failed_schema_load?: boolean
  loaders: Map<FieldID, boolean> = reactive(new Map())
  current_sync?: SyncProgressInfo

  images_raw_by_token: Map<string, OpFile[]> = reactive(new Map())
  images_by_name: Map<FileName, Map<FileToken, DuplicatedInfo[]>> = reactive(
    new Map(),
  )
  local_file_tokens: string[] = reactive([])
  images_to_download: OpFile[] = reactive([])

  /** Images raw array maps with cache */
  private _images_raw_array: OpFile[] = []
  private _images_raw_array_cache_invalid = true
  private _uniq_images_raw_array: OpFile[] = []
  private _uniq_images_raw_array_cache_invalid = true
  get images_raw_array(): OpFile[] {
    if (this._images_raw_array_cache_invalid) {
      console.log('invalid _images_raw_array_cache_invalid cache')
      this._images_raw_array = []
      for (const files of this.images_raw_by_token.values()) {
        this._images_raw_array.push(...files)
      }
      this._images_raw_array_cache_invalid = false
    }
    console.log('valid _images_raw_array_cache_invalid cache')
    return this._images_raw_array
  }
  get uniq_images_raw_array(): OpFile[] {
    if (this._uniq_images_raw_array_cache_invalid) {
      console.log('invalid _uniq_images_raw_array_cache_invalid cache')
      const seen = new Set<string>()
      this._uniq_images_raw_array = []
      for (const file of this.images_raw_array) {
        if (!seen.has(file.name)) {
          seen.add(file.name)
          this._uniq_images_raw_array.push(file)
        }
      }
      this._uniq_images_raw_array_cache_invalid = false
    }
    console.log('valid _uniq_images_raw_array_cache_invalid cache')
    return this._uniq_images_raw_array
  }

  constructor(public storage: StorageService, public json: FolderConfigJson) {
    this.api = reactive(new Api({ token: this.api_token })) as Api

    watch(
      () => Array.from(this.images_raw_by_token.entries()),
      () => {
        this._images_raw_array_cache_invalid = true
        this._uniq_images_raw_array_cache_invalid = true
      },
      { deep: true },
    )
  }

  get duplicated_images(): Map<FileName, Map<FileToken, DuplicatedInfo[]>> {
    return new Map(
      Array.from(this.images_by_name).filter(([, obj]) => obj.size > 1),
    )
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
  get keep_old_files(): boolean {
    return this.json.keep_old_files
  }
  set keep_old_files(keep_old_files: boolean) {
    this.json.keep_old_files = keep_old_files
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
  get is_stopping(): boolean {
    return this.current_sync?.is_stopping ?? false
  }
  get is_loading(): boolean {
    return this.loading_schema || !!this.loaders.size || this.is_downloading
  }
  getConfig(): FolderConfigJson {
    return {
      id: this.id,
      label: this.label,
      api_token: this.api_token,
      folder_path: this.folder_path,
      keep_old_files: this.json.keep_old_files,
      last_sync: this.last_sync,
    }
  }
  getCurrentDate(): string {
    return dayjs().format('YYYY-MM-DD HH:mm:ss')
  }
  resetRemoteFiles(): void {
    this.images_raw_by_token.clear()
    this.images_by_name.clear()
  }
  confirmDuplicatesAndContinue(): void {
    this.images_by_name.clear()
    this.checkMissingTokens()
  }
  // Load all files of the project
  async loadRemoteFiles(): Promise<void> {
    console.log('[loadRemoteFiles] check schema')
    if (!this.schema) {
      return
    }
    this.resetRemoteFiles()
    console.log('[loadRemoteFiles] triggered')

    for (const resource of this.schema.resources) {
      const media_fields = resource.fields.filter(f => f.isMedia())
      if (!media_fields.length) continue
      this.loaders.set(resource.id, true)
      const ids = await resource
        .query()
        .filter([
          '_or',
          ...media_fields.map(f => [f.name, 'not_empty', '']),
        ] as any[])
        .ids()
      const label_field = resource.fields.find(f => f.is_textual)
      const fields_to_load = media_fields
      if (label_field) fields_to_load.push(label_field)

      for (const id_chunk of chunk(ids, 10000)) {
        const things = await resource
          .query()
          .setFields(fields_to_load.map(f => f.name))
          .where('_id', 'in', id_chunk)
          .all()

        for (const thing of things) {
          for (const field of media_fields) {
            const langs = field.is_translatable
              ? field.schema().langs
              : [undefined]

            langs.forEach(lang => {
              const images: OpFile[] = thing.files(field, lang)

              images.forEach(image => {
                const bytoken = this.images_raw_by_token.get(image.token)
                if (!bytoken) this.images_raw_by_token.set(image.token, [image])
                else bytoken.push(image)

                let byname = this.images_by_name.get(image.name)
                if (!byname) {
                  byname = new Map()
                  this.images_by_name.set(image.name, byname)
                }

                let hastoken = byname.get(image.token)
                if (!hastoken) {
                  hastoken = []
                  byname.set(image.token, hastoken)
                }

                hastoken.push({
                  field,
                  thing_id: thing.id,
                  thing_label: label_field ? thing.val(label_field) : undefined,
                  file: image,
                  lang,
                })
              })
            })
          }
        }
      }

      this.loaders.delete(resource.id)
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
    this.setCurrentSyncDebounced(this, progressEvent)

    if (!progressEvent.downloading) {
      // Delete local files that are not present on remote anymore
      if (!this.keep_old_files) {
        window.electron.ipcRenderer.send(
          'deleteRemovedFilesFromRemote',
          cloneDeep({
            remote_files: [
              ...this.uniq_images_raw_array.map(file => file.serialize()),
            ],
            directory: this.folder_path,
          }),
        )
      }

      // Save sync
      this.saveLastSync(progressEvent)
    }
  }

  downloadFiles(): void {
    console.log('[downloader] start')
    if (!this.uniq_images_raw_array.length)
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
      is_stopping: false,
    })
    window.electron.ipcRenderer.send(
      'downloadFiles',
      cloneDeep({
        config_id: this.id,
        files: this.uniq_images_raw_array.map(file => ({
          url: file.link(),
          token: file.token,
          name: file.name,
        })),
        directory: this.folder_path,
        loader: this.current_sync,
        keep_old_files: this.keep_old_files,
      }),
    )
  }

  stopDownload(): void {
    console.log('sending stop signal', this.id)
    window.electron.ipcRenderer.send('stopDownload', this.id)
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
      is_stopping: false,
    }
    this.current_sync = undefined
    this.resetRemoteFiles()
    console.log('completed! save last sync')
    this.storage.setConfig(this.getConfig())
  }

  checkMissingTokens(): void {
    const params = {
      config_id: this.id,
      remote_files: Array.from(
        this.images_raw_by_token.values(),
      ).map<OpFileRaw>(files => files[0].serialize()),
      directory: this.folder_path,
    }
    /** On end this will trigger missingTokensToDownload from main */
    window.electron.ipcRenderer.send('checkMissingTokens', params)
  }

  async refresh(): Promise<void> {
    if (!this.schema) {
      try {
        this.loading_schema = true
        this.schema = reactive(await this.api.loadSchema()) as Schema
        this.failed_schema_load = false
      } catch (error) {
        this.failed_schema_load = true
      } finally {
        this.loading_schema = false
      }
    }
  }
}
