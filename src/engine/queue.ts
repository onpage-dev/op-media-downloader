/**
 * Runs `worker` over `items`, `concurrency` at a time. Items are taken with
 * an index (never `shift()`: that is O(n) per call on large arrays). When the
 * signal fires no new item starts; the ones running finish or abort on
 * their own. The first error of a worker is not caught here: workers report
 * their own failures, an exception ends the whole queue.
 */
export async function runQueue<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0
  let fatal: unknown
  const lanes = Math.max(1, Math.min(concurrency, items.length))
  const lane = async (): Promise<void> => {
    while (next < items.length && !signal?.aborted && fatal === undefined) {
      const index = next++
      try {
        await worker(items[index], index)
      } catch (error) {
        if (fatal === undefined) fatal = error
      }
    }
  }
  await Promise.all(Array.from({ length: lanes }, lane))
  if (fatal !== undefined) throw fatal
}
