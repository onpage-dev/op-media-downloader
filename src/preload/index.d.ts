import { ElectronAPI } from '@electron-toolkit/preload'
declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      store: {
        electronStoreChanged: any
        get: (key: string) => any
        set: (key: string, val: any) => any
        has: (key: string) => boolean
        delete: (key: string) => boolean
      }
    }
  }
}
