/**
 * Runs `worker` over `items`, `concurrency` at a time. Items are taken with
 * an index (never `shift()`: that is O(n) per call on large arrays). When the
 * signal fires no new item starts; the ones running finish or abort on
 * their own. Workers report their own failures: the first error a worker
 * throws stops the queue (no new item starts), and once the running ones
 * have finished it is thrown to the caller.
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
