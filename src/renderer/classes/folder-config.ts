import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import { chunk, cloneDeep, throttle, uniqBy } from 'lodash'
import {
  Api,
  Field,
  FieldID,
  FieldIdentifier,
  OpFile,
  OpFileRaw,
  Schema,
  SimpleFieldClause,
  Thing,
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
  load_fields_error = false
  current_sync?: SyncProgressInfo

  raw_files_by_token: Map<string, OpFile[]> = reactive(new Map())
  files_by_name: Map<FileName, Map<FileToken, DuplicatedInfo[]>> = reactive(
    new Map(),
  )
  local_file_tokens: string[] = reactive([])
  files_to_download: OpFile[] = reactive([])
  calculating_files_to_download = false

  /** Files raw array maps with cache */
  private _files: OpFile[] = []
  private _invalid_files_cache = true
  /** Unique token-name files */
  get files(): OpFile[] {
    if (this._invalid_files_cache) {
      console.log('Invalid files cache')
      this._files = uniqBy(
        Array.from(this.raw_files_by_token.values()).flatMap(files => files),
        f => `${f.token}-${f.name.toLocaleLowerCase()}`,
      )
      this._invalid_files_cache = false
    }
    return this._files
  }
  private _uniq_name_files: OpFile[] = []
  private _invalid_uniq_name_files_cache = true
  /** Uniquely named files */
  get uniq_name_files(): OpFile[] {
    if (this._invalid_uniq_name_files_cache) {
      console.log('Invalid uniq_name_files cache')
      this._uniq_name_files = uniqBy(this.files, f =>
        f.name.toLocaleLowerCase(),
      )
      this._invalid_uniq_name_files_cache = false
    }
    return this._uniq_name_files
  }

  constructor(public storage: StorageService, public json: FolderConfigJson) {
    this.api = reactive(new Api({ token: this.api_token })) as Api

    watch(
      () => Array.from(this.raw_files_by_token.entries()),
      () => {
        this._invalid_files_cache = true
        this._invalid_uniq_name_files_cache = true
      },
      { deep: true },
    )
  }

  get duplicated_files(): Map<FileName, Map<FileToken, DuplicatedInfo[]>> {
    return new Map(
      Array.from(this.files_by_name).filter(([, obj]) => obj.size > 1),
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
    return (
      this.loading_schema ||
      !!this.loaders.size ||
      this.is_downloading ||
      this.calculating_files_to_download
    )
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
    this.raw_files_by_token.clear()
    this.files_by_name.clear()
  }
  confirmDuplicatesAndContinue(): void {
    this.files_by_name.clear()
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

    try {
      this.load_fields_error = false
      for (const resource of this.schema.resources) {
        /** Pick all media fields that will be used to fetch the data */
        const media_fields: Field[] = resource.fields.filter(f => f.isMedia())
        if (!media_fields.length) continue
        this.loaders.set(resource.id, true)

        /** Get all the ThingIDs that have a value inside one of the media fields */
        const thing_ids: ThingID[] = await resource
          .query()
          .filter([
            '_or',
            ...media_fields.map<SimpleFieldClause>(f => [
              f.name,
              'not_empty',
              '',
            ]),
          ])
          .ids()

        /**
         * Check for a field to be used as the Thing label
         * if found add it to the fields to load array
         */
        const label_field = resource.fields.find(f => f.is_textual)
        const fields_to_load: FieldIdentifier[] = media_fields.map(f => f.name)
        if (label_field) fields_to_load.push(label_field.name)

        /** Split things load in chunks to avoid timeout */
        for (const ids_chunk of chunk(thing_ids, 10000)) {
          const things: Thing[] = await resource
            .query()
            .setFields(fields_to_load)
            .where('_id', 'in', ids_chunk)
            .all()

          for (const thing of things) {
            for (const field of media_fields) {
              /** If field is translatable get the value for each language of the schema */
              const langs: (string | undefined)[] = field.is_translatable
                ? field.schema().langs
                : [undefined]

              langs.forEach(lang => {
                const files: OpFile[] = thing.files(field, lang)

                /** Insert fetched files to the relative maps */
                files.forEach(file => {
                  const bytoken = this.raw_files_by_token.get(file.token)
                  if (!bytoken) this.raw_files_by_token.set(file.token, [file])
                  else bytoken.push(file)

                  const file_name = file.name.toLocaleLowerCase()
                  let byname = this.files_by_name.get(file_name)
                  if (!byname) {
                    byname = new Map()
                    this.files_by_name.set(file_name, byname)
                  }

                  let hastoken = byname.get(file.token)
                  if (!hastoken) {
                    hastoken = []
                    byname.set(file.token, hastoken)
                  }

                  hastoken.push({
                    field,
                    thing_id: thing.id,
                    thing_label: label_field
                      ? thing.val(label_field)
                      : undefined,
                    file,
                    lang,
                  })
                })
              })
            }
          }
        }

        this.loaders.delete(resource.id)
      }
    } catch (error) {
      console.error('folderConfig.loadRemoteFiles()', error)
      this.load_fields_error = true
      this.loaders.clear()
      this.resetRemoteFiles()
    } finally {
      this.calculating_files_to_download = true
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
    progressEvent: ConfigEvents['update-download-progress']['progressEvent'],
  ): void {
    this.setCurrentSyncDebounced(this, progressEvent)

    if (!progressEvent.downloading) {
      // Delete local files that are not present on remote anymore
      if (!this.keep_old_files) {
        window.electron.ipcRenderer.send(
          'delete-removed-files-from-remote',
          cloneDeep({
            remote_files: [
              ...this.uniq_name_files.map(file => file.serialize()),
            ],
            directory: this.folder_path,
          }),
        )
      }

      /** Clear loaders in case of stop-download */
      if (progressEvent.is_stopping == true) {
        this.loaders.clear()
      }

      // Save sync
      this.saveLastSync(progressEvent)
    }
  }

  downloadFiles(): void {
    console.log('[downloader] start')
    if (!this.uniq_name_files.length)
      return console.log('[downloader] no files')
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
      'download-files',
      cloneDeep({
        config_id: this.id,
        files: this.uniq_name_files.map(file => ({
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
    window.electron.ipcRenderer.send('stop-download', this.id)
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
      remote_files: this.uniq_name_files.map<OpFileRaw>(file =>
        file.serialize(),
      ),
      directory: this.folder_path,
    }
    /** On end this will trigger missingTokensToDownload from main */
    window.electron.ipcRenderer.send('check-missing-tokens', params)
    window.electron.ipcRenderer.on('update-missing-tokens', () => {
      this.calculating_files_to_download = false
    })
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
