/** ProjectService with a fake engine: edits one at a time, removal, jobs, an engine that keeps stopping */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineCommand, EngineRequest, EngineToMain } from '../shared/engine-protocol'
import { FolderInfo, FolderProblem, ProjectRuntime, ProjectView } from '../shared/models'
import { NO_TIMEOUT } from './engine-host'
import { Engine, ENGINE_DOWN, ProjectService, RemovedProject } from './projects'
import { AppStore } from './store'

const electron = vi.hoisted(() => ({ opened: [] as string[] }))

vi.mock('electron', () => {
  const api = {
    app: { getPath: () => os.tmpdir(), getVersion: () => '2.0.0', isPackaged: false },
    ipcMain: { on: () => undefined },
    shell: {
      openPath: async (folder: string) => {
        electron.opened.push(folder)
        return ''
      },
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => Buffer.from(`enc:${text}`),
      decryptString: (buffer: Buffer) => {
        const text = buffer.toString()
        if (!text.startsWith('enc:')) throw new Error('Error while decrypting')
        return text.slice(4)
      },
    },
    utilityProcess: { fork: () => undefined },
  }
  return { ...api, default: api }
})
vi.mock('./log', () => ({ log: () => undefined }))

interface Request {
  request: EngineRequest
  timeout_ms?: number
  settled: boolean
  resolve: (data: unknown) => void
  reject: (error: Error) => void
}

/** Records what main asks; the test answers the requests and speaks for the engine */
class FakeEngine implements Engine {
  available = true
  revived = 0
  commands: EngineCommand[] = []
  requests: Request[] = []
  private listeners = new Set<(message: EngineToMain) => void>()
  private crash_listeners = new Set<() => void>()
  private unavailable_listeners = new Set<() => void>()

  revive(): void {
    this.available = true
    this.revived++
  }

  command(command: EngineCommand): void {
    this.commands.push(command)
  }

  request<T>(request: EngineRequest, timeout_ms?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: Request = {
        request,
        timeout_ms,
        settled: false,
        resolve: data => {
          entry.settled = true
          resolve(data as T)
        },
        reject: error => {
          entry.settled = true
          reject(error)
        },
      }
      this.requests.push(entry)
    })
  }

  onMessage(listener: (message: EngineToMain) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onCrash(listener: () => void): () => void {
    this.crash_listeners.add(listener)
    return () => this.crash_listeners.delete(listener)
  }

  onUnavailable(listener: () => void): () => void {
    this.unavailable_listeners.add(listener)
    return () => this.unavailable_listeners.delete(listener)
  }

  /** The request of that type still waiting for an answer */
  pending(type: EngineRequest['type']): Request | undefined {
    return this.requests.find(entry => entry.request.type == type && !entry.settled)
  }

  count(type: EngineRequest['type']): number {
    return this.requests.filter(entry => entry.request.type == type).length
  }

  state(project_id: string, runtime: Partial<ProjectRuntime>): void {
    this.emit({ kind: 'state', project_id, runtime: { phase: 'idle', issues: [], ...runtime } })
  }

  emit(message: EngineToMain): void {
    for (const listener of this.listeners) listener(message)
  }

  giveUp(): void {
    this.available = false
    for (const listener of this.unavailable_listeners) listener()
  }
}

const dirs: string[] = []
let engine: FakeEngine
let store: AppStore
let projects: ProjectService
let folder: string

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opmd-projects-'))
  dirs.push(dir)
  folder = path.join(dir, 'Media')
  fs.mkdirSync(folder)
  electron.opened = []
  engine = new FakeEngine()
  store = new AppStore({ cwd: dir })
  projects = new ProjectService(store, engine)
})

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

async function until(condition: () => unknown, timeout_ms = 2_000): Promise<void> {
  const end = Date.now() + timeout_ms
  while (!condition()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function info(target: string, problems: FolderProblem[] = [], problem_detail?: string): FolderInfo {
  return { path: target, kind: 'local', exists: true, writable: true, problems, problem_detail, inspected_at: new Date().toISOString() }
}

/** A project on the test folder, the inspection answered as fine */
async function created(label = 'Catalogo'): Promise<ProjectView> {
  const creating = projects.create({ label, token: 'token', folder, keep_old_files: false })
  await until(() => engine.pending('inspect_folder'))
  engine.pending('inspect_folder')!.resolve(info(folder))
  return creating
}

describe('editing', () => {
  it('creates a project on a folder the engine finds usable', async () => {
    const view = await created()
    expect(view).toMatchObject({ label: 'Catalogo', folder, has_token: true, runtime: { phase: 'idle' } })
    expect(store.token(store.project(view.id)!)).toBe('token')
    expect(engine.commands.at(-1)).toEqual({ type: 'configure', project_folders: [{ id: view.id, folder }] })
  })

  it('creates one project at a time: the second finds the folder taken by the first', async () => {
    const first = projects.create({ label: 'A', token: 't', folder, keep_old_files: false })
    const second = projects.create({ label: 'B', token: 't', folder, keep_old_files: false })
    await until(() => engine.pending('inspect_folder'))
    await sleep(20)
    expect(engine.count('inspect_folder')).toBe(1)

    engine.pending('inspect_folder')!.resolve(info(folder))
    const view = await first
    await until(() => engine.pending('inspect_folder'))
    /** The engine knows the folder of the first project by now */
    expect(engine.commands.filter(c => c.type == 'configure').at(-1)).toMatchObject({ project_folders: [{ id: view.id, folder }] })
    engine.pending('inspect_folder')!.resolve(info(folder, ['used_by_other_project'], view.id))

    await expect(second).rejects.toThrow('folder_used_by_other_project')
    expect(store.projects.map(p => p.label)).toEqual(['A'])
  })

  it('an edit waits for a create in progress', async () => {
    const view = await created()
    const creating = projects.create({ label: 'Other', token: 't', folder: path.join(folder, '..', 'Other'), keep_old_files: false })
    const editing = projects.update(view.id, { label: 'Renamed' })
    await sleep(20)
    expect(store.project(view.id)?.label).toBe('Catalogo')
    engine.pending('inspect_folder')!.resolve(info(folder, ['protected']))
    await expect(creating).rejects.toThrow('folder_protected')
    await expect(editing).resolves.toMatchObject({ label: 'Renamed' })
  })

  it('does not edit a project while its job runs, also when the job starts during the folder inspection', async () => {
    const view = await created()
    engine.state(view.id, { phase: 'downloading', job: 'download' })
    await expect(projects.update(view.id, { label: 'X' })).rejects.toThrow('project_busy')
    engine.state(view.id, { phase: 'idle' })

    const other = path.join(folder, '..', 'Other')
    const editing = projects.update(view.id, { folder: other })
    await until(() => engine.pending('inspect_folder'))
    engine.state(view.id, { phase: 'listing', job: 'sync' })
    engine.pending('inspect_folder')!.resolve(info(other))
    await expect(editing).rejects.toThrow('project_busy')
    expect(store.project(view.id)?.folder).toBe(folder)
  })

  it('a new token or folder forgets what was known of the project', async () => {
    const view = await created()
    store.patchProject(view.id, { issues: [{ code: 'failed_files', severity: 'warning', count: 3, at: '2026-01-01T00:00:00.000Z' }] })
    const next = await projects.update(view.id, { token: 'another' })
    expect(next.runtime.issues).toEqual([])
    expect(engine.commands).toContainEqual({ type: 'forget', project_id: view.id })
    expect(store.token(store.project(view.id)!)).toBe('another')
  })
})

describe('removing', () => {
  it('removes the project at once and lets the engine forget it', async () => {
    const view = await created()
    await projects.remove(view.id, { delete_files: false })
    expect(projects.views()).toEqual([])
    await until(() => engine.commands.some(c => c.type == 'forget'))
    expect(engine.commands).toContainEqual({ type: 'forget', project_id: view.id })
    await expect(projects.remove(view.id, { delete_files: false })).rejects.toThrow('project_not_found')
  })

  it('deletes the files in the background, with no time limit, keeping the folder taken meanwhile', async () => {
    const view = await created()
    await projects.remove(view.id, { delete_files: true })
    expect(projects.views()).toEqual([])
    expect(store.project(view.id)).toBeUndefined()
    expect(projects.isDeleting()).toBe(true)
    expect(projects.projectFolders()).toEqual([{ id: view.id, folder }])

    await until(() => engine.pending('delete_project_files'))
    const request = engine.pending('delete_project_files')!
    expect(request.timeout_ms).toBe(NO_TIMEOUT)
    expect(request.request).toMatchObject({ project: { id: view.id, folder, token: 'token' } })
    /** A second click finds nothing to remove */
    await expect(projects.remove(view.id, { delete_files: true })).rejects.toThrow('project_not_found')

    request.resolve({ removed_files: 3, removed_folder: true, kept_entries: 0 })
    await until(() => !projects.isDeleting())
    expect(projects.projectFolders()).toEqual([])
  })

  it('stops the job of the project before deleting its files', async () => {
    const view = await created()
    projects.startJob(view.id, 'download')
    engine.state(view.id, { phase: 'downloading', job: 'download' })
    await projects.remove(view.id, { delete_files: true })

    expect(projects.views()).toEqual([])
    expect(engine.commands).toContainEqual({ type: 'stop', project_id: view.id })
    expect(projects.isRunning()).toBe(true)
    await sleep(150)
    expect(engine.pending('delete_project_files')).toBeUndefined()

    engine.state(view.id, { phase: 'stopping', job: 'download' })
    engine.state(view.id, { phase: 'idle' })
    await until(() => engine.pending('delete_project_files'))
    expect(projects.isRunning()).toBe(false)
  })

  it('tries again while the engine says the project is busy, then reports the failure', async () => {
    const failures: RemovedProject[] = []
    projects.onDeleteFailed(project => failures.push(project))
    const view = await created()
    await projects.remove(view.id, { delete_files: true })

    await until(() => engine.pending('delete_project_files'))
    engine.pending('delete_project_files')!.reject(new Error('project_busy'))
    await until(() => engine.count('delete_project_files') == 2 && engine.pending('delete_project_files'))
    engine.pending('delete_project_files')!.reject(new Error('folder_unreachable: the share does not answer'))

    await until(() => failures.length == 1)
    expect(failures[0]).toEqual({ id: view.id, label: 'Catalogo', folder })
    expect(engine.count('delete_project_files')).toBe(2)
    expect(engine.commands).toContainEqual({ type: 'forget', project_id: view.id })
    await until(() => !projects.isDeleting())
  })
})

describe('jobs', () => {
  it('starts each job with its engine command, one at a time per project', async () => {
    const view = await created()
    const last = (): EngineCommand | undefined => engine.commands.at(-1)

    projects.startJob(view.id, 'sync', { full_listing: true })
    expect(last()).toMatchObject({ type: 'sync', full_listing: true, project: { id: view.id, token: 'token' } })
    expect(projects.views()[0].runtime).toMatchObject({ phase: 'preparing', job: 'sync' })
    const sent = engine.commands.length
    projects.startJob(view.id, 'download')
    expect(engine.commands).toHaveLength(sent)

    for (const [job, type] of [
      ['download', 'download'],
      ['retry_failed', 'retry_failed'],
      ['cleanup', 'confirm_cleanup'],
    ] as const) {
      engine.state(view.id, { phase: 'idle' })
      projects.startJob(view.id, job)
      expect(last()).toMatchObject({ type, project: { id: view.id } })
    }
    expect(() => projects.startJob('unknown', 'sync')).toThrow('project_not_found')
  })

  it('an engine that keeps stopping gives every project the unexpected issue until a job starts it again', async () => {
    const view = await created()
    engine.giveUp()
    expect(projects.views()[0].runtime.issues[0]).toMatchObject({ code: 'unexpected', severity: 'error', detail: ENGINE_DOWN })
    /** What main does on its own does not start it */
    void projects.refreshFolders()
    projects.configureEngine()
    expect(engine.revived).toBe(0)

    projects.startJob(view.id, 'sync')
    expect(engine.revived).toBe(1)
    expect(projects.views()[0].runtime.issues.some(issue => issue.detail == ENGINE_DOWN)).toBe(false)
    expect(engine.commands.at(-1)).toMatchObject({ type: 'sync' })
  })

  it('the issue of the engine down is not saved', async () => {
    const view = await created()
    engine.giveUp()
    engine.state(view.id, { phase: 'idle', issues: projects.views()[0].runtime.issues })
    expect(store.project(view.id)?.issues ?? []).toEqual([])
  })
})

describe('reading', () => {
  it('opens the folder of a project only when it is there and is a folder', async () => {
    const view = await created()
    await projects.openFolder(view.id)
    expect(electron.opened).toEqual([folder])

    fs.rmSync(folder, { recursive: true })
    fs.writeFileSync(folder, 'now a file')
    await expect(projects.openFolder(view.id)).rejects.toThrow('open_failed')
    fs.rmSync(folder)
    await expect(projects.openFolder(view.id)).rejects.toThrow('open_failed')
    expect(electron.opened).toEqual([folder])
  })

  it('a project whose token cannot be decrypted asks for one', async () => {
    const view = await created()
    store.patchProject(view.id, { token_enc: Buffer.from('from another computer').toString('base64') })
    expect(projects.views()[0].has_token).toBe(false)
    expect(projects.revealToken(view.id)).toBe('')
    await expect(projects.verifyProjectToken(view.id)).resolves.toEqual({ ok: false, error: 'token_invalid' })
  })
})
