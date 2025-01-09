export function processQueue<T>(
  todo: (() => Promise<T>)[],
  concurrentCount = 1,
): { promise: Promise<void>; stop: () => void } {
  let running = true
  const complete: (() => Promise<T>)[] = []
  const threads: Promise<void>[] = []

  for (let i = 0; i < concurrentCount; i++) {
    console.log('start thread')
    threads.push(runThread())
  }

  const promise = Promise.all(threads).then(() => {
    console.log('All threads completed')
  })

  function stop(): void {
    console.log('Stopping all threads')
    running = false
  }

  async function runThread(): Promise<void> {
    let promise: (() => Promise<T>) | undefined
    while (running && (promise = todo.shift())) {
      try {
        console.log('wait for promise')
        await promise()
      } catch (e) {
        console.log('promise error', e)
      } finally {
        console.log('promise ended')
        complete.push(promise)
      }
    }
  }

  return { promise, stop }
}
