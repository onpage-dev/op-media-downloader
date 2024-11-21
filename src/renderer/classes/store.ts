import { IpcRendererEvent } from '@electron-toolkit/preload'
import { cloneDeep, forEach } from 'lodash'
import { OpFileRaw } from 'onpage-js'
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
    // On Progress
    window.electron.ipcRenderer.on(
      'downloadProgress',
      (
        _event: IpcRendererEvent,
        config_id: string,
        progressEvent: SyncProgressInfo,
      ) => {
        const c = this.configs.get(config_id)
        if (!c) return
        c.onDownloadProgress(progressEvent)
      },
    )

    // missing tokens to download
    window.electron.ipcRenderer.on(
      'missingTokensToDownload',
      (
        _event: IpcRendererEvent,
        config_id: string,
        missing_files: OpFileRaw[],
      ) => {
        const c = this.configs.get(config_id)
        if (!c) return
        c.images_to_download = c.uniq_images_raw_array.filter(image =>
          missing_files.find(img => img.token == image.token),
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
