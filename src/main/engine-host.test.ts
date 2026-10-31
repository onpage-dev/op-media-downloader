/** The engine host: restarts with backoff, gives up on an engine that keeps stopping, restarts a hung one */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineInit, EngineProject } from '../shared/engine-protocol'
import { EngineHost, NO_TIMEOUT, STOP_TIMEOUT_MS } from './engine-host'

/** Utility processes that only record and exit when told */
const fake = vi.hoisted(() => {
  class FakeChild {
    posted: unknown[] = []
    killed = false
    private handlers = new Map<string, ((...args: any[]) => void)[]>()

    on(event: string, handler: (...args: any[]) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args)
    }

    postMessage(message: unknown): void {
      this.posted.push(message)
    }

    kill(): boolean {
      this.killed = true
      this.emit('exit', 1)
      return true
    }
  }
  return { FakeChild, children: [] as FakeChild[] }
})

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      const child = new fake.FakeChild()
      fake.children.push(child)
      return child
    },
  },
}))
vi.mock('./log', () => ({ log: () => undefined }))

const INIT: EngineInit = { cache_dir: '/cache', project_folders: [], concurrency: 4, app_version: '2.0.0', instance_id: 'test' }
const PROJECT: EngineProject = { id: 'p1', label: 'P', token: 't', folder: '/p1', keep_old_files: false }

const last = (): InstanceType<typeof fake.FakeChild> => fake.children.at(-1)!

let host: EngineHost

beforeEach(() => {
  vi.useFakeTimers()
  fake.children.length = 0
  host = new EngineHost(() => INIT)
})

afterEach(() => {
  host.dispose()
  vi.useRealTimers()
})

describe('restarts', () => {
  it('restarts an engine that exits, with backoff, and gives up after 5 restarts in 2 minutes', async () => {
    const crashes = vi.fn()
    const unavailable = vi.fn()
    host.onCrash(crashes)
    host.onUnavailable(unavailable)
    host.start()
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      last().emit('exit', 1)
      vi.advanceTimersByTime(delay - 1)
      const before = fake.children.length
      vi.advanceTimersByTime(1)
      expect(fake.children.length).toBe(before + 1)
    }
    expect(fake.children).toHaveLength(6)
    expect(unavailable).not.toHaveBeenCalled()

    last().emit('exit', 1)
    expect(crashes).toHaveBeenCalledTimes(6)
    expect(unavailable).toHaveBeenCalledTimes(1)
    expect(host.available).toBe(false)
    await expect(host.request({ type: 'get_activity', project_id: 'p1' })).rejects.toThrow('engine_unavailable')
    vi.advanceTimersByTime(10 * 60_000)
    expect(fake.children).toHaveLength(6)

    host.revive()
    expect(host.available).toBe(true)
    expect(fake.children).toHaveLength(7)
  })

  it('the healthy timer of an older engine does not reset the backoff of a newer one', () => {
    host.start()
    last().emit('message', { kind: 'ready' })
    vi.advanceTimersByTime(50_000)
    last().emit('exit', 1)
    /** First restart: 1 s */
    vi.advanceTimersByTime(1_000)
    expect(fake.children).toHaveLength(2)
    last().emit('message', { kind: 'ready' })
    /** The first engine's minute would be over now */
    vi.advanceTimersByTime(15_000)
    last().emit('exit', 1)
    vi.advanceTimersByTime(1_500)
    expect(fake.children).toHaveLength(2)
    vi.advanceTimersByTime(500)
    expect(fake.children).toHaveLength(3)
  })

  it('an engine up for a minute starts the backoff over', () => {
    host.start()
    last().emit('exit', 1)
    vi.advanceTimersByTime(1_000)
    last().emit('exit', 1)
    vi.advanceTimersByTime(2_000)
    last().emit('message', { kind: 'ready' })
    vi.advanceTimersByTime(60_000)
    last().emit('exit', 1)
    vi.advanceTimersByTime(1_000)
    expect(fake.children).toHaveLength(4)
  })
})

describe('requests', () => {
  it('rejects the requests in flight when the engine exits', async () => {
    host.start()
    last().emit('message', { kind: 'ready' })
    const asked = host.request({ type: 'delete_project_files', project: PROJECT }, NO_TIMEOUT)
    last().emit('exit', 1)
    await expect(asked).rejects.toThrow('engine_crashed')
  })

  it('times out after 5 minutes unless asked to wait as long as it takes', async () => {
    host.start()
    last().emit('message', { kind: 'ready' })
    const timed = host.request({ type: 'get_activity', project_id: 'p1' })
    const untimed = host.request<{ removed_files: number }>({ type: 'delete_project_files', project: PROJECT }, NO_TIMEOUT)
    const settled = vi.fn()
    void untimed.then(settled, settled)
    vi.advanceTimersByTime(5 * 60_000)
    await expect(timed).rejects.toThrow('engine_timeout:get_activity')
    vi.advanceTimersByTime(60 * 60_000)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    const request_id = (last().posted.at(-1) as { request_id: number }).request_id
    last().emit('message', { kind: 'response', request_id, ok: true, data: { removed_files: 3 } })
    await expect(untimed).resolves.toEqual({ removed_files: 3 })
  })
})

describe('the stop watchdog', () => {
  it('restarts an engine whose job does not stop within a minute', () => {
    host.start()
    last().emit('message', { kind: 'ready' })
    const first = last()
    host.command({ type: 'download', project: PROJECT })
    host.command({ type: 'stop', project_id: 'p1' })
    vi.advanceTimersByTime(STOP_TIMEOUT_MS - 1)
    expect(first.killed).toBe(false)
    vi.advanceTimersByTime(1)
    expect(first.killed).toBe(true)
    vi.advanceTimersByTime(1_000)
    expect(fake.children).toHaveLength(2)
  })

  it('leaves alone a job that stops in time, or a project without a job', () => {
    host.start()
    last().emit('message', { kind: 'ready' })
    host.command({ type: 'download', project: PROJECT })
    last().emit('message', { kind: 'state', project_id: 'p1', runtime: { phase: 'stopping', issues: [] } })
    vi.advanceTimersByTime(30_000)
    last().emit('message', { kind: 'state', project_id: 'p1', runtime: { phase: 'idle', issues: [] } })
    host.command({ type: 'stop', project_id: 'p1' })
    host.command({ type: 'stop', project_id: 'p2' })
    vi.advanceTimersByTime(5 * STOP_TIMEOUT_MS)
    expect(last().killed).toBe(false)
    expect(fake.children).toHaveLength(1)
  })

  it('watches a stop the engine reports on its own', () => {
    host.start()
    last().emit('message', { kind: 'ready' })
    last().emit('message', { kind: 'state', project_id: 'p1', runtime: { phase: 'stopping', issues: [] } })
    vi.advanceTimersByTime(STOP_TIMEOUT_MS)
    expect(fake.children[0].killed).toBe(true)
  })
})
