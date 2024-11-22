import {
  IPCInvokeChannels,
  IPCSendChannels,
} from './electron-ipc-renderer-models'

export type IPCMainOnChannels = IPCSendChannels
export type IPCMainHandleChannels<T = any> = IPCInvokeChannels<T>
