/**
 * Starts the sync engine in an Electron utility process, relays commands and
 * requests, and restarts it (with backoff) if it exits unexpectedly. An
 * engine that keeps stopping (more than MAX_RESTARTS restarts in
 * RESTART_WINDOW_MS) stays down until revive(); a job that does not stop
 * within STOP_TIMEOUT_MS means a hung engine, which is killed and restarted.
 */
import { utilityProcess, UtilityProcess } from 'electron'
import path from 'path'
import { EngineCommand, EngineInit, EngineRequest, EngineToMain, MainToEngine } from '../shared/engine-protocol'
import { ProjectId } from '../shared/models'
import { log } from './log'

type Listener = (message: EngineToMain) => void

interface Pending {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer?: NodeJS.Timeout
}

const REQUEST_TIMEOUT_MS = 5 * 60_000
/** `request(…, NO_TIMEOUT)`: deleting the files of a project on a slow share takes as long as it takes */
export const NO_TIMEOUT = 0
/** Up this long after `ready`: the next exit starts the backoff over */
const HEALTHY_AFTER_MS = 60_000
const MAX_RESTARTS = 5
const RESTART_WINDOW_MS = 2 * 60_000
const MAX_BACKOFF_MS = 30_000
/** A job still stopping after this is hung: the engine is restarted */
export const STOP_TIMEOUT_MS = 60_000

export class EngineHost {
  private child?: UtilityProcess
  private ready = false
  private quitting = false
  /** Restarted too often: down until revive() */
  private given_up = false
  private backlog: MainToEngine[] = []
  private pending = new Map<number, Pending>()
  private next_request_id = 1
  /** Restarts since the engine was last healthy, for the backoff */
  private restarts = 0
  /** When the engine exited unexpectedly, within the last RESTART_WINDOW_MS */
  private exits: number[] = []
  /** One at a time: the timer of an older engine must not vouch for a newer one */
  private healthy_timer?: NodeJS.Timeout
  private restart_timer?: NodeJS.Timeout
  /** Projects with a job in the engine, and the watchdogs of those stopping */
  private running = new Set<ProjectId>()
  private watchdogs = new Map<ProjectId, NodeJS.Timeout>()
  private listeners = new Set<Listener>()
  private crash_listeners = new Set<() => void>()
  private unavailable_listeners = new Set<() => void>()

  constructor(private init: () => EngineInit) {}

  /** False after dispose() and while the engine is given up */
  get available(): boolean {
    return !this.quitting && !this.given_up
  }

  start(): void {
    clearTimeout(this.restart_timer)
    this.restart_timer = undefined
    let child: UtilityProcess
    try {
      child = utilityProcess.fork(path.join(__dirname, 'engine.js'), [], {
        serviceName: 'Media Downloader sync engine',
        stdio: 'pipe',
        /** More libuv threads: on network folders every file system call waits for the server */
        env: { ...process.env, UV_THREADPOOL_SIZE: '16' },
      })
    } catch (error) {
      log('error', 'Cannot start the sync engine', error)
      this.exited(-1)
      return
    }
    child.stdout?.on('data', data => log('debug', `[engine] ${String(data).trimEnd()}`))
    child.stderr?.on('data', data => log('warn', `[engine] ${String(data).trimEnd()}`))
    child.on('message', (message: EngineToMain) => {
      if (child == this.child) this.receive(message)
    })
    child.on('exit', code => {
      if (child != this.child) return
      this.child = undefined
      this.exited(code)
    })
    this.child = child
    this.ready = false
    child.postMessage({ kind: 'command', command: { type: 'init', init: this.init() } } satisfies MainToEngine)
  }

  /** Starts the engine again after it was given up: the user asked for a job */
  revive(): void {
    if (!this.given_up || this.quitting) return
    this.given_up = false
    this.restarts = 0
    this.exits = []
    log('info', 'Sync engine started again')
    this.start()
  }

  /** Stop for good (app quitting) */
  dispose(): void {
    this.quitting = true
    clearTimeout(this.healthy_timer)
    clearTimeout(this.restart_timer)
    this.settleAll()
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

  /** The engine keeps stopping: it is not restarted until revive() */
  onUnavailable(listener: () => void): () => void {
    this.unavailable_listeners.add(listener)
    return () => this.unavailable_listeners.delete(listener)
  }

  command(command: EngineCommand): void {
    if (!this.available) {
      log('debug', `Sync engine down: ${command.type} dropped`)
      return
    }
    this.track(command)
    this.send({ kind: 'command', command })
  }

  /** timeout_ms: NO_TIMEOUT waits for the answer however long it takes */
  request<T>(request: EngineRequest, timeout_ms = REQUEST_TIMEOUT_MS): Promise<T> {
    if (!this.available) return Promise.reject(new Error('engine_unavailable'))
    const request_id = this.next_request_id++
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeout_ms > 0
          ? setTimeout(() => {
              this.pending.delete(request_id)
              reject(new Error(`engine_timeout:${request.type}`))
            }, timeout_ms)
          : undefined
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
        clearTimeout(this.healthy_timer)
        this.healthy_timer = setTimeout(() => (this.restarts = 0), HEALTHY_AFTER_MS)
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
      case 'state':
        if (message.runtime.phase == 'idle') this.settle(message.project_id)
        else {
          this.running.add(message.project_id)
          if (message.runtime.phase == 'stopping') this.watch(message.project_id)
        }
        break
      case 'result':
        this.settle(message.project_id)
        break
    }
    for (const listener of this.listeners) listener(message)
  }

  /** Which projects have a job, so that a stop that never ends is noticed even when the engine says nothing */
  private track(command: EngineCommand): void {
    switch (command.type) {
      case 'sync':
      case 'download':
      case 'retry_failed':
      case 'confirm_cleanup':
        this.running.add(command.project.id)
        return
      case 'stop':
        if (this.running.has(command.project_id)) this.watch(command.project_id)
        return
      case 'forget':
        /** A forgotten project gets no more states */
        this.settle(command.project_id)
        return
    }
  }

  private watch(id: ProjectId): void {
    if (this.watchdogs.has(id)) return
    const timer = setTimeout(() => {
      this.watchdogs.delete(id)
      log('error', `The job of project ${id} did not stop in ${STOP_TIMEOUT_MS / 1000} s: restarting the sync engine`)
      this.child?.kill()
    }, STOP_TIMEOUT_MS)
    this.watchdogs.set(id, timer)
  }

  private settle(id: ProjectId): void {
    this.running.delete(id)
    clearTimeout(this.watchdogs.get(id))
    this.watchdogs.delete(id)
  }

  private settleAll(): void {
    for (const timer of this.watchdogs.values()) clearTimeout(timer)
    this.watchdogs.clear()
    this.running.clear()
  }

  /** The engine exited (or could not start): restart it, with backoff, unless it keeps stopping */
  private exited(code: number): void {
    this.ready = false
    clearTimeout(this.healthy_timer)
    this.healthy_timer = undefined
    this.settleAll()
    if (this.quitting) return
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('engine_crashed'))
    }
    this.pending.clear()
    /** Messages queued for the dead process would act on stale state */
    this.backlog = []
    for (const listener of this.crash_listeners) listener()

    const now = Date.now()
    this.exits = [...this.exits.filter(at => now - at < RESTART_WINDOW_MS), now]
    if (this.exits.length > MAX_RESTARTS) {
      this.given_up = true
      log(
        'error',
        `Sync engine exited with code ${code}: it stopped ${this.exits.length} times in ${RESTART_WINDOW_MS / 60_000} minutes, not restarted`,
      )
      for (const listener of this.unavailable_listeners) listener()
      return
    }
    const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** this.restarts++)
    log('error', `Sync engine exited with code ${code}, restarting in ${delay / 1000} s`)
    this.restart_timer = setTimeout(() => {
      this.restart_timer = undefined
      if (this.available) this.start()
    }, delay)
  }
}
