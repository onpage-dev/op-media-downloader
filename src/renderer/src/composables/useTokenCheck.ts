/**
 * The check of a token, in the wizard and in the project's settings: a token
 * typed (after a pause in the typing) or the saved one, which main checks
 * without showing it to the page. An answer for an older token is dropped; the
 * pause ends with the component.
 */
import { onScopeDispose, ref, type Ref } from 'vue'
import type { ProjectId, TokenCheck } from '@shared/models'
import { verifyProjectToken, verifyToken } from '../store'
import { useAction } from './useAction'

export interface TokenCheckState {
  /** `checking` while main asks On Page */
  check: Ref<TokenCheck | 'checking' | undefined>
  /** Why the check could not be made (not why a token is wrong: that is the check's answer) */
  error: Ref<string | undefined>
  verify: (token: string) => Promise<TokenCheck | undefined>
  verifySaved: (id: ProjectId) => Promise<TokenCheck | undefined>
  /** The token being typed, half a second after the last key */
  verifyLater: (token: string) => void
  reset: () => void
}

const PAUSE_MS = 500

export function useTokenCheck(): TokenCheckState {
  const check = ref<TokenCheck | 'checking'>()
  const action = useAction('verify token', (question: () => Promise<TokenCheck>) => question())
  let timer: ReturnType<typeof setTimeout> | undefined

  async function ask(question: () => Promise<TokenCheck>): Promise<TokenCheck | undefined> {
    clearTimeout(timer)
    check.value = 'checking'
    const answer = await action.run(question)
    if (answer) check.value = answer
    // Failed (the error says why); a newer question keeps its own `checking`
    else if (!action.busy.value && check.value == 'checking') check.value = undefined
    return answer
  }
  function reset(): void {
    clearTimeout(timer)
    action.clear()
    check.value = undefined
  }
  onScopeDispose(() => clearTimeout(timer))

  return {
    check,
    error: action.error,
    verify: token => ask(() => verifyToken(token)),
    verifySaved: id => ask(() => verifyProjectToken(id)),
    verifyLater(token) {
      reset()
      if (token) timer = setTimeout(() => void ask(() => verifyToken(token)), PAUSE_MS)
    },
    reset,
  }
}
