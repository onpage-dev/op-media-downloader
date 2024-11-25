import { OpFileRaw } from 'onpage-js'
interface SyncProgressInfo {
  start_time: string
  downloading: boolean
  is_stopping: boolean
  total: number
  downloaded: number
  failed: number
  already_exists: number
}
// Payload types for send
export interface IPCSendChannels {
  'get-version-info': undefined
  'open-url': string
  'open-path': string
  'delete-folder': string
  'delete-removed-files-from-remote': {
    remote_files: OpFileRaw[]
    directory: string
  }
  'download-files': {
    config_id: string
    files: {
      url: string
      token: string
      name: string
    }[]
    directory: string
    loader: SyncProgressInfo
    keep_old_files: boolean
  }
  'stop-download': string
  'check-missing-tokens': {
    config_id: string
    remote_files: OpFileRaw[]
    directory: string
  }
}

// Payload types for on
export interface IPCOnChannels {
  'update-missing-tokens': undefined
  'update-version-info': {
    current: string
    latest?: string
  }
  'update-download-progress': {
    config_id: string
    progressEvent: SyncProgressInfo
  }
  'update-missing-tokens-to-download': {
    config_id: string
    missing_files: OpFileRaw[]
  }
  'electron-store-changed': Readonly<Record<string, unknown>>
}

// Payload and return types for invoke
export interface IPCInvokeChannels<T = any> {
  'pick-folder-path': { payload: undefined; return: string }
  'electron-store-set': {
    payload: { key: string; val: T }
    return: T
  }
  'electron-store-delete': {
    payload: string
    return: boolean
  }
  'electron-store-get': {
    payload: string
    return: T
  }
  'electron-store-has': {
    payload: string
    return: boolean
  }
}
