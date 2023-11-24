import { ElectronAPI } from '@electron-toolkit/preload'
import { Ref } from 'vue'
declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      store: {
        electronStoreChanged: any
      }
    }
    version_info: Ref<
      | undefined
      | {
          current: string
          latest: string
        }
    >
  }
}
