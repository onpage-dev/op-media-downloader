import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: undefined }))

/** The process listeners the module added: removed after the test */
let cleanup = (): void => undefined

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the engine process', () => {
  it('ends on an uncaught exception, after logging it (main starts a new one)', async () => {
    const posted: unknown[] = []
    Object.assign(process, {
      parentPort: { postMessage: (message: unknown) => posted.push(message), on: () => undefined },
    })
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exceptions = process.listeners('uncaughtException')
    const rejections = process.listeners('unhandledRejection')
    await import('./index')
    const exception = process.listeners('uncaughtException').filter(l => !exceptions.includes(l))
    const rejection = process.listeners('unhandledRejection').filter(l => !rejections.includes(l))
    cleanup = (): void => {
      for (const listener of exception) process.removeListener('uncaughtException', listener)
      for (const listener of rejection) process.removeListener('unhandledRejection', listener)
    }
    expect(exception).toHaveLength(1)

    exception[0](new Error('boom'), 'uncaughtException')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(posted).toContainEqual(
      expect.objectContaining({ kind: 'log', level: 'error', message: expect.stringContaining('boom') }),
    )
  })
})
