/**
 * Starts the sync engine in an Electron utility process, relays commands and
 * requests, and restarts it (with backoff) if it exits unexpectedly.
 */
import { utilityProcess, UtilityProcess } from 'electron'
import path from 'path'
import {
  EngineCommand,
  EngineInit,
  EngineRequest,
  EngineToMain,
  MainToEngine,
} from '../shared/engine-protocol'
import { log } from './log'

type Listener = (message: EngineToMain) => void

interface Pending {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const REQUEST_TIMEOUT_MS = 5 * 60_000

export class EngineHost {
  private child?: UtilityProcess
  private ready = false
  private quitting = false
  private backlog: MainToEngine[] = []
  private pending = new Map<number, Pending>()
  private next_request_id = 1
  private restarts = 0
  private listeners = new Set<Listener>()
  private crash_listeners = new Set<() => void>()

  constructor(private init: () => EngineInit) {}

  start(): void {
    const child = utilityProcess.fork(path.join(__dirname, 'engine.js'), [], {
      serviceName: 'Media Downloader sync engine',
      stdio: 'pipe',
      /** More libuv threads: on network folders every file system call waits for the server */
      env: { ...process.env, UV_THREADPOOL_SIZE: '16' },
    })
    child.stdout?.on('data', data => log('debug', `[engine] ${String(data).trimEnd()}`))
    child.stderr?.on('data', data => log('warn', `[engine] ${String(data).trimEnd()}`))
    child.on('message', (message: EngineToMain) => this.receive(message))
    child.on('exit', code => this.onExit(code))
    this.child = child
    this.ready = false
    child.postMessage({ kind: 'command', command: { type: 'init', init: this.init() } } satisfies MainToEngine)
  }

  /** Stop for good (app quitting) */
  dispose(): void {
    this.quitting = true
    this.child?.kill()
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The engine died: running jobs are lost */
  onCrash(listener: () => void): () => void {
    this.crash_listeners.add(listener)
    return () => this.crash_listeners.delete(listener)
  }

  command(command: EngineCommand): void {
    this.send({ kind: 'command', command })
  }

  request<T>(request: EngineRequest, timeout_ms = REQUEST_TIMEOUT_MS): Promise<T> {
    const request_id = this.next_request_id++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id)
        reject(new Error(`engine_timeout:${request.type}`))
      }, timeout_ms)
      this.pending.set(request_id, { resolve: data => resolve(data as T), reject, timer })
      this.send({ kind: 'request', request_id, request })
    })
  }

  private send(message: MainToEngine): void {
    if (this.ready && this.child) this.child.postMessage(message)
    else this.backlog.push(message)
  }

  private receive(message: EngineToMain): void {
    switch (message.kind) {
      case 'ready':
        this.ready = true
        for (const queued of this.backlog.splice(0)) this.child?.postMessage(queued)
        return
      case 'response': {
        const pending = this.pending.get(message.request_id)
        if (!pending) return
        this.pending.delete(message.request_id)
        clearTimeout(pending.timer)
        if (message.ok) pending.resolve(message.data)
        else pending.reject(new Error(message.error ?? 'engine_error'))
        return
      }
      case 'log':
        log(message.level, `[engine]${message.project_id ? ` [${message.project_id}]` : ''} ${message.message}`)
        break
    }
    for (const listener of this.listeners) listener(message)
  }

  private onExit(code: number): void {
    this.child = undefined
    this.ready = false
    if (this.quitting) return
    log('error', `Sync engine exited with code ${code}, restarting`)
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('engine_crashed'))
    }
    this.pending.clear()
    /** Messages queued for the dead process would act on stale state */
    this.backlog = []
    for (const listener of this.crash_listeners) listener()
    const delay = Math.min(30_000, 1_000 * 2 ** this.restarts++)
    setTimeout(() => {
      if (!this.quitting) this.start()
    }, delay)
    /** A process that stays up for a minute is healthy again */
    setTimeout(() => {
      if (this.child) this.restarts = 0
    }, delay + 60_000)
  }
}
