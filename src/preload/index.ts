import { electronAPI } from '@electron-toolkit/preload'
import { contextBridge, ipcRenderer } from 'electron'
// Custom APIs for renderer
const api = {
  store: {
    electronStoreChanged: (callback): any =>
      ipcRenderer.on('electron-store-changed', callback),
    get(key: string): any {
      return ipcRenderer.sendSync('electron-store-get', key)
    },
    set(property: string, val: any): any {
      ipcRenderer.send('electron-store-set', property, val)
    },
    has(key: string): boolean {
      return ipcRenderer.sendSync('electron-store-has', key)
    },
    delete(key: string): boolean {
      return ipcRenderer.sendSync('electron-store-delete', key)
    },
    // Other method you want to add like has(), reset(), etc.
  },
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
