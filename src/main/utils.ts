export function sleep(millis: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, millis))
}

export async function processQueue<T>(
  todo: (() => Promise<T>)[],
  concurrentCount = 1,
): Promise<void> {
  const complete: (() => Promise<T>)[] = []
  const threads: Promise<void>[] = []
  for (let i = 0; i < concurrentCount; i++) {
    console.log('start thread')
    threads.push(runThread())
  }
  await Promise.all(threads)
  return

  async function runThread(): Promise<void> {
    let promise: (() => Promise<T>) | undefined
    while ((promise = todo.shift())) {
      if (!promise) return
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
}
