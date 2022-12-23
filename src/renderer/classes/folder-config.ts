import dayjs from 'dayjs'
import { cloneDeep, flatMap, forEach, uniqBy } from 'lodash'
import { Api, FieldID, OpFile, OpFileRaw, Resource, Schema } from 'onpage-js'
import { reactive } from 'vue'
import utc from 'dayjs/plugin/utc'
dayjs.extend(utc)
export interface UserSettings {
  dark_mode?: boolean
}
export interface StorageDataJson {
  user_properties: UserSettings
  storage_data: { [key: string]: FolderConfig }
}
export class StorageData {
  json: StorageDataJson = reactive({
    storage_data: {},
    user_properties: {},
  })
  config_services: Map<string, FolderConfigService> = new Map()

  constructor() {
    this.watchStore()
    this.initStorage()
  }

  async initStorage(): Promise<void> {
    const has_storage_data = await this.has('storage_data')
    if (!has_storage_data) {
      await this.set('storage_data', {})
    }
    const has_user_properties = await this.has('user_properties')
    if (!has_user_properties) {
      await this.set('user_properties', { dark_mode: false })
    }

    this.json.user_properties = await this.get('user_properties')
    this.json.storage_data = await this.get('storage_data')
    this.updateConfigServicesMap()
  }
  get user_properties(): UserSettings {
    return this.json.user_properties
  }
  get storage_data(): { [key: string]: FolderConfig } {
    return this.json.storage_data
  }

  async set<T>(key: string, val: T): Promise<T> {
    const res: T = await window.electron.ipcRenderer.invoke(
      'electron-store-set',
      key,
      val,
    )
    return res
  }
  async delete(key: string): Promise<boolean> {
    const res: boolean = await window.electron.ipcRenderer.invoke(
      'electron-store-delete',
      key,
    )
    return res
  }
  async get<T>(key: string): Promise<T> {
    const res = await window.electron.ipcRenderer.invoke(
      'electron-store-get',
      key,
    )
    return res
  }
  async has(key: string): Promise<boolean> {
    const res: boolean = await window.electron.ipcRenderer.invoke(
      'electron-store-has',
      key,
    )
    return res
  }

  async setConfig(f: FolderConfig): Promise<void> {
    const selector = `storage_data.${f.api_token}`
    await this.set(selector, cloneDeep(f))
  }

  updateConfigServicesMap(): void {
    forEach(this.storage_data, val => {
      if (this.config_services.has(val.api_token)) {
        const config = this.config_services.get(val.api_token)!
        Object.assign(config, val)
      } else {
        this.config_services.set(
          val.api_token,
          new FolderConfigService(this, val),
        )
      }
    })
  }
  watchStore(): void {
    window.api.store.electronStoreChanged(
      (_event: any, new_val: StorageDataJson): void => {
        console.log('store_changed', new_val)
        Object.assign(this.json, new_val)
        this.updateConfigServicesMap()
      },
    )
  }
}

export interface FolderConfig {
  label: string
  api_token: string
  folder_path: string
  last_sync?: SyncResult
}
export class FolderConfigService {
  api: Api
  schema?: Schema
  loaders: Map<FieldID, boolean> = reactive(new Map())
  download_loaders: Map<
    string,
    {
      downloading: boolean
      total_size?: any
      downloaded_size?: any
    }
  > = reactive(new Map())

  images_raw: Map<FieldID, OpFileRaw[]> = reactive(new Map())
  images: Map<FieldID, OpFile[]> = reactive(new Map())
  local_file_tokens: string[] = reactive([])

  constructor(public storage_data: StorageData, public json: FolderConfig) {
    this.api = reactive(new Api('app', this.api_token)) as Api
    void this.refresh()
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
  get all_files_raw(): OpFileRaw[] {
    return flatMap(Array.from(this.images_raw), ([, val]) => val)
  }
  get all_files(): OpFile[] {
    return uniqBy(
      flatMap(Array.from(this.images), ([, val]) => val),
      (file: OpFile) => file.token,
    )
  }
  get is_downloading(): boolean {
    return Array.from(this.download_loaders.values())
      .map(val => val.downloading)
      .includes(true)
  }
  get is_loading(): boolean {
    return Array.from(this.loaders.values()).includes(true)
  }
  getConfig(): FolderConfig {
    return {
      label: this.label,
      api_token: this.api_token,
      folder_path: this.folder_path,
      last_sync: this.last_sync,
    }
  }
  formatLocalFiles(): OpFileRaw[] {
    return cloneDeep(
      this.all_files
        .filter(file => this.local_file_tokens.includes(file.name))
        .map(file => file.serialize()) ?? [],
    )
  }
  getCurrentDate(): string {
    return dayjs().format('YYYY-MM-DD HH:mm:ss')
  }
  // load remote files then download the missing ones
  // finally update the index inside storage_data
  async syncFiles(): Promise<void> {
    this.download_loaders.clear()
    const current_sync_info: Partial<SyncResult> = {
      start_time: this.getCurrentDate(),
      local_files: this.formatLocalFiles(),
    }
    await this.loadRemoteFiles()
    this.all_files.forEach(file => this.downloadFile(file, current_sync_info))
  }
  // Start download of a file
  downloadFile(
    file: OpFile,
    current_sync_info: Partial<SyncResult>,
  ): Promise<any> {
    const _this = reactive(this)

    return new Promise((resolve, reject) => {
      const clear_listeners = (): void => {
        window.electron.ipcRenderer.removeAllListeners('downloadEnd')
        window.electron.ipcRenderer.removeAllListeners('downloadProgress')
        window.electron.ipcRenderer.removeAllListeners('downloadError')
        window.electron.ipcRenderer.removeAllListeners('fileAlreadyExists')
      }
      _this.download_loaders.set(file.token, { downloading: true })
      window.electron.ipcRenderer.send('downloadFile', {
        url: file.link(),
        directory: this.folder_path,
        token: file.token,
        name: file.name,
      })

      // Already Exists
      window.electron.ipcRenderer.on('fileAlreadyExists', () => {
        clear_listeners()
        const loader = _this.download_loaders.get(file.token)!
        loader.downloading = false
        this.saveLastSync(current_sync_info)
      })

      // On Progress
      window.electron.ipcRenderer.on(
        'downloadProgress',
        (_event, progressEvent) => {
          const loader = _this.download_loaders.get(file.token)!
          loader.total_size = progressEvent.total
          loader.downloaded_size = progressEvent.loaded
        },
      )

      // On End
      window.electron.ipcRenderer.on('downloadEnd', () => {
        clear_listeners()
        resolve(`${this.folder_path}/${file.token}`)

        const loader = _this.download_loaders.get(file.token)!
        loader.downloading = false
        this.saveLastSync(current_sync_info)
      })

      // On Error
      window.electron.ipcRenderer.on('downloadError', (_event, error) => {
        clear_listeners()
        reject(error)

        const loader = _this.download_loaders.get(file.token)!
        loader.downloading = false
        this.saveLastSync(current_sync_info)
      })
    })
  }
  saveLastSync(current_sync_info: Partial<SyncResult>): void {
    if (!this.is_downloading) {
      setTimeout(() => {
        current_sync_info.end_time = this.getCurrentDate()
        current_sync_info.remote_files = this.all_files_raw ?? []

        const config = this.getConfig()
        config.last_sync = current_sync_info as SyncResult
        this.storage_data.setConfig(config)
      }, 1000)
    }
  }
  // Load all files of the project
  async loadRemoteFiles(): Promise<void> {
    if (!this.schema) return
    try {
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

interface SyncResult {
  remote_files: OpFileRaw[]
  local_files: OpFileRaw[]
  start_time: string
  end_time: string
}
