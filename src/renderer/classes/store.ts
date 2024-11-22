import { IpcRendererEvent } from '@electron-toolkit/preload'
import { cloneDeep, forEach } from 'lodash'
import { reactive } from 'vue'
import {
  FolderConfig,
  FolderConfigJson,
  SyncProgressInfo,
} from './folder-config'

export const SUPPORTED_LANGS = ['it', 'en'] as const
export type SupportedLang = (typeof SUPPORTED_LANGS)[number]

export type ConfigEvents = {
  downloadProgress: {
    event: IpcRendererEvent
    config_id: string
    progressEvent: SyncProgressInfo
  }
}

export interface Store {
  electronStoreChanged: any
  get: (key: string) => any
  set: (key: string, val: any) => void
  has: (key: string) => boolean
  delete: (key: string) => boolean
}

export interface UserSettings {
  dark_mode?: boolean
  simultaneous_downloads?: number
  language?: SupportedLang
}

export interface StorageServiceJson {
  user_properties: UserSettings
  storage_data: { [key: string]: FolderConfigJson }
}
export class StorageService {
  json: StorageServiceJson = reactive({
    storage_data: {},
    user_properties: {},
  })
  configs: Map<string, FolderConfig> = reactive(new Map())

  constructor() {
    this.watchStore()
    this.initStorage()
    this.initRenderEvents()
  }

  initRenderEvents(): void {
    window.electron.ipcRenderer.on('update-download-progress', (_event, data) => {
      const c = this.configs.get(data.config_id)
      if (!c) return
      c.onDownloadProgress(data.progressEvent)
    })

    window.electron.ipcRenderer.on(
      'update-missing-tokens-to-download',
      (_event, data) => {
        const c = this.configs.get(data.config_id)
        if (!c) return
        const missing_tokens = new Set(data.missing_files.map(f => f.token))
        c.images_to_download = c.uniq_images_raw_array.filter(({ token }) =>
          missing_tokens.has(token),
        )
      },
    )
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
    return window.electron.ipcRenderer.invoke<'electron-store-set', T>(
      'electron-store-set',
      {
        key,
        val,
      },
    )
  }
  async delete(key: string): Promise<boolean> {
    return window.electron.ipcRenderer.invoke('electron-store-delete', key)
  }
  async get<T>(key: string): Promise<T> {
    return window.electron.ipcRenderer.invoke<'electron-store-get', T>(
      'electron-store-get',
      key,
    )
  }
  async has(key: string): Promise<boolean> {
    return window.electron.ipcRenderer.invoke('electron-store-has', key)
  }

  async setConfig(f: FolderConfigJson): Promise<void> {
    const selector = `storage_data.${f.id}`
    await this.set(selector, cloneDeep(f))
  }

  updateConfigServicesMap(): void {
    const keys_to_update = Object.keys(this.storage_data)

    // Delete removed configs
    Array.from(this.configs.keys())
      .filter(key => !keys_to_update.includes(key))
      .forEach(key => this.configs.delete(key))

    const init_new_config = (val: FolderConfigJson): void => {
      const config = reactive(new FolderConfig(this, val)) as FolderConfig
      config.refresh()
      this.configs.set(val.id, config)
    }
    // Now Update or add configs
    forEach(this.storage_data, val => {
      if (this.configs.has(val.id)) {
        const config = this.configs.get(val.id)!
        if (val.api_token !== config.api_token) {
          init_new_config(val)
        } else {
          Object.assign(config, val)
        }
      } else {
        init_new_config(val)
      }
    })
  }
  watchStore(): void {
    window.api.store.electronStoreChanged(
      (_event: any, new_val: StorageServiceJson): void => {
        console.log('store_changed', new_val)
        Object.assign(this.json, new_val)
        this.updateConfigServicesMap()
      },
    )
  }
}
