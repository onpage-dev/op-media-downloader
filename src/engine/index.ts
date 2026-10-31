/**
 * Sync engine entry, run by main as an Electron utility process.
 * Downloads and On Page requests go through Electron's `net.fetch` (Chromium
 * network stack: system proxy, PAC, certificates like the browser); Node's
 * `fetch` is the fallback when `net` is not available.
 */
// More libuv threads: on a network folder every file system call waits for
// the server, and 4 threads (the default) serialise them. Must be set before
// the first asynchronous fs call; main can also pass it in the fork env.
process.env.UV_THREADPOOL_SIZE ??= '16'

import { net } from 'electron'
import { EngineToMain, MainToEngine } from '../shared/engine-protocol'
import { Engine } from './engine'
import { FetchLike } from './http'

const port = process.parentPort

function post(message: EngineToMain): void {
  port.postMessage(message)
}

const electronFetch: FetchLike | undefined =
  typeof net?.fetch == 'function'
    ? (url, init): Promise<Response> => net.fetch(url, init as never)
    : undefined

const engine = new Engine({
  fetch: electronFetch ?? ((url, init): Promise<Response> => fetch(url, init)),
  post,
})

process.on('uncaughtException', error => {
  post({
    kind: 'log',
    level: 'error',
    message: `Engine uncaught exception: ${error?.stack ?? error}`,
  })
})
process.on('unhandledRejection', error => {
  post({
    kind: 'log',
    level: 'error',
    message: `Engine unhandled rejection: ${(error as Error)?.stack ?? error}`,
  })
})

port.on('message', ({ data }: { data: MainToEngine }) => {
  try {
    engine.receive(data)
  } catch (error) {
    post({
      kind: 'log',
      level: 'error',
      message: `Engine message failed: ${(error as Error)?.stack ?? error}`,
    })
  }
})

if (!electronFetch)
  post({
    kind: 'log',
    level: 'warn',
    message: 'net.fetch not available: using Node fetch (no system proxy)',
  })
