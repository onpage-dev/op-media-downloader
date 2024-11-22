import {
  IPCMainHandleChannels,
  IPCMainOnChannels,
} from '../shared/electron-ipc-main-models'

export class ElectronIPC {
  /**
   * Listen for events from the renderer process.
   * @param channel The channel to listen to.
   * @param listener The callback to handle the event payload.
   */
  static on<K extends keyof IPCMainOnChannels>(
    channel: K,
    listener: (
      event: Electron.IpcMainEvent,
      payload: IPCMainOnChannels[K],
    ) => void,
  ): void {
    const { ipcMain } = require('electron') // Dynamically import ipcMain for main process
    ipcMain.on(channel, listener)
  }

  static handle<K extends keyof IPCMainHandleChannels>(
    channel: K,
    handler: (
      event: Electron.IpcMainInvokeEvent,
      payload: IPCMainHandleChannels[K]['payload'],
    ) =>
      | IPCMainHandleChannels[K]['return']
      | Promise<IPCMainHandleChannels[K]['return']>,
  ): void {
    const { ipcMain } = require('electron') // Dynamically import ipcMain for main process
    ipcMain.handle(channel, handler)
  }
}
