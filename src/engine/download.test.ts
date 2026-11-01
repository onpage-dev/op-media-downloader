import path from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { downloadToFile } from './download'
import { FetchLike } from './http'
import { FsOp, injectFaults } from './testing/faults'
import { cleanupTempDirs, listDir, tempDir } from './testing/tmp'

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(cleanupTempDirs)

/** A server that keeps sending: what is left of the body after the download gave up */
function endlessBody(): {
  fetch: FetchLike
  signal: () => AbortSignal | undefined
  cancelled: () => boolean
} {
  let signal: AbortSignal | undefined
  let cancelled = false
  const fetch: FetchLike = async (_url, init) => {
    signal = init?.signal ?? undefined
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        await new Promise(resolve => setTimeout(resolve, 2))
        controller.enqueue(new Uint8Array(1024).fill(7))
      },
      cancel: () => {
        cancelled = true
      },
    })
    return new Response(body, {
      headers: { 'content-length': String(64 * 1024 * 1024) },
    })
  }
  return { fetch, signal: () => signal, cancelled: () => cancelled }
}

describe('a download that fails on the disk', () => {
  it.each<[string, FsOp, string]>([
    ['the temporary file cannot be created', 'open', 'EACCES'],
    ['the disk refuses a write', 'write', 'ENOSPC'],
  ])('%s: the connection is closed at once, nothing is left', async (_label, op, code) => {
    const dir = await tempDir()
    const server = endlessBody()
    injectFaults([{ op, path: f => f.endsWith('.download'), code, after: op == 'write' ? 3 : 0 }])
    await expect(
      downloadToFile({
        fetch: server.fetch,
        url: 'http://127.0.0.1/file',
        target: path.join(dir, 'e4f0e64e9d56231bda0efc5aae8e00a5ee0bce3a'),
      }),
    ).rejects.toThrow(code)
    expect(server.signal()?.aborted).toBe(true)
    expect(server.cancelled()).toBe(true)
    expect(await listDir(dir)).toEqual([])
  })
})
