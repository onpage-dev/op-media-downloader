import { cloneDeep, forEach } from 'lodash'
import { reactive } from 'vue'
import { FolderConfigJson, FolderConfig } from './folder-config'

export interface Store {
  electronStoreChanged: any
  get: (key: string) => any
  set: (key: string, val: any) => void
  has: (key: string) => boolean
  delete: (key: string) => boolean
}

export interface UserSettings {
  dark_mode?: boolean
}

export interface LocalStoreDataJson {
  user_properties: UserSettings
  storage_data: { [key: string]: FolderConfigJson }
}
export class LocalStoreData {
  json: LocalStoreDataJson = reactive({
    storage_data: {},
    user_properties: {},
  })
  config_services: Map<string, FolderConfig> = new Map()

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
  get storage_data(): { [key: string]: FolderConfigJson } {
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

  async setConfig(f: FolderConfigJson): Promise<void> {
    const selector = `storage_data.${f.api_token}`
    await this.set(selector, cloneDeep(f))
  }

  updateConfigServicesMap(): void {
    forEach(this.storage_data, val => {
      if (this.config_services.has(val.api_token)) {
        const config = this.config_services.get(val.api_token)!
        Object.assign(config, val)
      } else {
        this.config_services.set(val.api_token, new FolderConfig(this, val))
      }
    })
  }
  watchStore(): void {
    window.api.store.electronStoreChanged(
      (_event: any, new_val: LocalStoreDataJson): void => {
        console.log('store_changed', new_val)
        Object.assign(this.json, new_val)
        this.updateConfigServicesMap()
      },
    )
  }
}
