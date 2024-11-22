import { OpFileRaw } from 'onpage-js'
import { SyncProgressInfo } from '@classes/folder-config'

// Payload types for send
export interface IPCSendChannels {
  getVersionInfo: undefined
  openURL: string
  deleteFolder: string
  openPath: string
  deleteRemovedFilesFromRemote: { remote_files: OpFileRaw[]; directory: string }
  downloadFiles: {
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
  stopDownload: string
  checkMissingTokens: {
    config_id: string
    remote_files: OpFileRaw[]
    directory: string
  }
}

// Payload types for on
export interface IPCOnChannels {
  setVersionInfo: {
    current: string
    latest: string
  }
  downloadProgress: {
    config_id: string
    progressEvent: SyncProgressInfo
  }
  missingTokensToDownload: {
    config_id: string
    missing_files: OpFileRaw[]
  }
  'electron-store-changed': string
}

// Payload and return types for invoke
export interface IPCInvokeChannels<T = any> {
  pickFolderPath: { payload: undefined; return: string }
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
