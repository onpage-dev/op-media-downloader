import { OpFileRaw } from 'onpage-js'
import { reactive, Ref } from 'vue'
import { Store } from './store'

export interface UserSettings {
  dark_mode?: boolean
}
export interface StorageDataJson {
  user_properties: UserSettings
  storage_data: FolderConfig[]
}
export class StorageData {
  store: Store
  json: StorageDataJson = reactive({
    user_properties: {},
    storage_data: [],
  })
  constructor() {
    this.store = reactive(window.api.store)
    this.watchStore()
    this.initStorage()
  }

  initStorage(): void {
    if (!this.store.has('storage_data')) {
      this.store.set('storage_data', [])
    }
    if (!this.store.has('user_properties')) {
      this.store.set('user_properties', { dark_mode: false })
    }

    this.json.user_properties = this.store.get('user_properties')
    this.json.storage_data = this.store.get('storage_data')
  }

  watchStore(): void {
    window.api.store.electronStoreChanged(
      (_event: any, new_val: StorageDataJson): void => {
        console.log('store_changed')
        Object.assign(this.json, new_val)
      },
    )
  }

  get config_services(): FolderConfigService[] {
    return this.configs.map(config => new FolderConfigService(config))
  }

  get user_properties(): UserSettings {
    return this.json.user_properties
  }
  set user_properties(val: UserSettings) {
    this.store.set('user_properties', val)
  }

  get configs(): FolderConfig[] {
    return this.json.storage_data
  }
  set configs(val: FolderConfig[]) {
    this.store.set('storage_data', val)
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
function ref(store: {
  electronStoreChanged: () => (event: any, val: any) => void
  get: (key: string) => any
  set: (key: string, val: any) => any
  has: (key: string) => boolean
  delete: (key: string) => boolean
}): Store {
  throw new Error('Function not implemented.')
}
