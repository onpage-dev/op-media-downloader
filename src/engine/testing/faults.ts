/**
 * File system faults for the tests: the errors a full disk, a dropped share,
 * an unplugged disk, an antivirus or a read-only folder give, injected into
 * `fs.promises` (which every module of the engine uses).
 */
import fs from 'fs'
import type { FileHandle } from 'fs/promises'
import path from 'path'
import { vi } from 'vitest'

export type FsOp =
  | 'open'
  | 'write'
  | 'sync'
  | 'rename'
  | 'link'
  | 'unlink'
  | 'copyFile'
  | 'readFile'
  | 'writeFile'
  | 'stat'
  | 'readdir'
  | 'access'
  | 'rm'

export interface Fault {
  op: FsOp
  /** Which paths: the target of rename, link and copyFile */
  path?: (file: string) => boolean
  code: string
  /** Fires this many times, then the operation works again (default: always) */
  times?: number
  /** Lets the first `after` matching calls through */
  after?: number
}

export interface Faults {
  /** Calls that failed, by operation */
  fired: Map<FsOp, number>
  /** Lifts every fault (the spies stay, the operations work again) */
  clear(): void
  add(fault: Fault): void
  /** Writes take at most this many bytes per call */
  shortWrites?: number
}

const ops = fs.promises as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>

function errno(code: string, op: string, file: string): Error {
  return Object.assign(new Error(`${code}: injected, ${op} '${file}'`), {
    code,
    syscall: op,
    path: file,
  })
}

/** Only the paths below `dir` */
export const under =
  (dir: string) =>
  (file: string): boolean =>
    path.resolve(file).toLowerCase().startsWith(path.resolve(dir).toLowerCase())

export function injectFaults(initial: Fault[] = []): Faults {
  let faults: (Fault & { seen: number; fired: number })[] = []
  const state: Faults = {
    fired: new Map(),
    clear: () => {
      faults = []
      state.shortWrites = undefined
    },
    add: fault => faults.push({ ...fault, seen: 0, fired: 0 }),
  }
  for (const fault of initial) state.add(fault)

  const check = (op: FsOp, file: string): void => {
    for (const fault of faults) {
      if (fault.op != op || (fault.path && !fault.path(file))) continue
      fault.seen++
      if (fault.seen <= (fault.after ?? 0)) continue
      if (fault.times !== undefined && fault.fired >= fault.times) continue
      fault.fired++
      state.fired.set(op, (state.fired.get(op) ?? 0) + 1)
      throw errno(fault.code, op, file)
    }
  }

  const wrap = (op: FsOp, target: (args: unknown[]) => string): void => {
    const original = ops[op].bind(fs.promises)
    vi.spyOn(ops, op).mockImplementation(async (...args: unknown[]) => {
      check(op, String(target(args)))
      const result = await original(...args)
      return op == 'open' ? handleOf(result as FileHandle, String(args[0])) : result
    })
  }

  const handleOf = (handle: FileHandle, file: string): FileHandle => {
    const write = handle.write.bind(handle) as (...args: unknown[]) => Promise<{ bytesWritten: number }>
    const sync = handle.sync.bind(handle)
    return new Proxy(handle, {
      get(target, key, receiver) {
        if (key == 'write')
          return async (data: Uint8Array, offset = 0, length = data.byteLength - offset) => {
            check('write', file)
            const max = state.shortWrites
            return write(data, offset, max ? Math.min(max, length) : length)
          }
        if (key == 'sync')
          return async () => {
            check('sync', file)
            return sync()
          }
        const value = Reflect.get(target, key, receiver)
        return typeof value == 'function' ? value.bind(target) : value
      },
    })
  }

  wrap('open', a => a[0] as string)
  wrap('rename', a => a[1] as string)
  wrap('link', a => a[1] as string)
  wrap('unlink', a => a[0] as string)
  wrap('copyFile', a => a[1] as string)
  wrap('readFile', a => a[0] as string)
  wrap('writeFile', a => a[0] as string)
  wrap('stat', a => a[0] as string)
  wrap('readdir', a => a[0] as string)
  wrap('access', a => a[0] as string)
  wrap('rm', a => a[0] as string)
  return state
}

/** What the disk says it has free, now (a function: it can change during the run) */
export function fakeFreeSpace(bytes: number | (() => number)): void {
  vi.spyOn(fs.promises, 'statfs').mockImplementation(async () => {
    const free = typeof bytes == 'number' ? bytes : bytes()
    return {
      type: 0,
      bsize: 4096,
      blocks: 1_000_000_000,
      bfree: Math.floor(free / 4096),
      bavail: Math.floor(free / 4096),
      files: 0,
      ffree: 0,
    } as never
  })
}
