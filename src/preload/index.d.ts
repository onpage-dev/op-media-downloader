import { Ref } from 'vue'
import {
  IPCInvokeChannels,
  IPCOnChannels,
  IPCSendChannels,
} from '@shared/electron-ipc-renderer-models'
import * as Electron from 'electron'

declare global {
  interface Window {
    electron: {
      ipcRenderer: {
        // Independent typing for `on`
        on<K extends keyof IPCOnChannels>(
          channel: K,
          listener: (
            event: Electron.IpcRendererEvent,
            payload: IPCOnChannels[K],
          ) => void,
        ): void

        // Independent typing for `send`
        send<K extends keyof IPCSendChannels>(
          channel: K,
          payload?: IPCSendChannels[K],
        ): void

        // Independent typing for `invoke`
        invoke<
          K extends keyof IPCInvokeChannels = keyof IPCInvokeChannels,
          T = IPCInvokeChannels[K]['return'],
        >(
          channel: K,
          payload?: IPCInvokeChannels<T>[K]['payload'],
        ): Promise<T>
      }
    }
    api: {
      store: {
        electronStoreChanged: any
      }
    }
    version_info: Ref<
      | undefined
      | {
          current: string
          latest?: string
        }
    >
  }
}
