/**
 * Sync engine entry, run by main as an Electron utility process.
 * Placeholder until the engine lands: answers `init` with `ready`.
 */
import { EngineToMain, MainToEngine } from '../shared/engine-protocol'

const port = process.parentPort

function post(message: EngineToMain): void {
  port.postMessage(message)
}

port.on('message', ({ data }: { data: MainToEngine }) => {
  if (data.kind == 'command' && data.command.type == 'init') post({ kind: 'ready' })
})
