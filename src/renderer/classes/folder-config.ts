import { forEach } from 'lodash'
import { OpFileRaw } from 'onpage-js'
import { reactive } from 'vue'

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
  config_services?: FolderConfigService[]

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
    console.log('saving', f)
    const selector = `storage_data.${f.api_token}`
    await this.set(`${selector}.label`, f.label)
    await this.set(`${selector}.api_token`, f.api_token)
    await this.set(`${selector}.folder_path`, f.folder_path)
  }

  watchStore(): void {
    window.api.store.electronStoreChanged(
      (_event: any, new_val: StorageDataJson): void => {
        console.log('store_changed', new_val)
        Object.assign(this.json, new_val)

        this.config_services = []
        forEach(this.storage_data, val => {
          this.config_services?.push(new FolderConfigService(val))
        })
      },
    )
  }
}

export interface FolderConfig {
  label: string
  api_token: string
  folder_path: string
  last_sync?: SyncResult
  current_status?: SyncResult
}
export class FolderConfigService {
  label: string
  api_token: string
  folder_path: string
  last_sync?: SyncResult
  current_status?: SyncResult

  constructor(json: FolderConfig) {
    this.label = json.label
    this.api_token = json.api_token
    this.folder_path = json.folder_path
    this.last_sync = json.last_sync
    this.current_status = json.current_status
  }

  async sync(): Promise<void> {
    console.log('sync folder')
  }
}

interface SyncResult {
  remote_files: OpFileRaw[]
  local_files: OpFileRaw[]
  start_time: string
  end_time: string
}
