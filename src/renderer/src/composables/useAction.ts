/**
 * A call to main made by a form: `busy` while it runs, `error` in words when it
 * fails (the details in main's log), said in place rather than in a toast. A
 * newer call, `clear()` or the end of the component drop the answer of an older
 * one: it resolves undefined.
 */
import { onScopeDispose, ref, type Ref } from 'vue'
import { errorText, logError } from '../lib/errors'

export interface Action<A extends unknown[], R> {
  run: (...args: A) => Promise<R | undefined>
  busy: Ref<boolean>
  error: Ref<string | undefined>
  clear: () => void
}

export function useAction<A extends unknown[], R>(what: string, action: (...args: A) => Promise<R>): Action<A, R> {
  const busy = ref(false)
  const error = ref<string>()
  let calls = 0
  async function run(...args: A): Promise<R | undefined> {
    const call = ++calls
    busy.value = true
    error.value = undefined
    try {
      const result = await action(...args)
      return call == calls ? result : undefined
    } catch (failure) {
      logError(what, failure, 'warn')
      if (call == calls) error.value = errorText(failure)
      return undefined
    } finally {
      if (call == calls) busy.value = false
    }
  }
  function clear(): void {
    calls++
    busy.value = false
    error.value = undefined
  }
  onScopeDispose(() => calls++)
  return { run, busy, error, clear }
}
