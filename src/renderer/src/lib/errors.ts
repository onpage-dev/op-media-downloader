/**
 * What a failed call to main says to the user. Main rejects with a code
 * (`project_busy`, `engine_timeout:sync`, `folder_protected`…): a code with a
 * text of its own gets it, a folder's problem the title of its check, any
 * other the generic text naming the code. Never Electron's or a stack's words.
 * The details go to main's log.
 */
import { i18n } from '../i18n'

const CODE = /^[a-z][a-z0-9_]*$/

/** The code before the detail (`engine_timeout:sync` → `engine_timeout`); `unexpected` for what is no code */
export function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = message.split(':')[0].trim()
  return CODE.test(code) ? code : 'unexpected'
}

export function errorText(error: unknown): string {
  const { t, te } = i18n.global
  const code = errorCode(error)
  if (code != 'generic' && te(`errors.${code}`)) return t(`errors.${code}`)
  const problem = code.startsWith('folder_') ? code.slice('folder_'.length) : ''
  if (problem && te(`check.${problem}.title`)) return t(`check.${problem}.title`)
  return t('errors.generic', { detail: code })
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  return String(error)
}

/** Into main's log, and the console for the developer tools */
export function logError(where: string, error: unknown, level: 'warn' | 'error' = 'error'): void {
  console[level](where, error)
  try {
    window.desktop?.app.log(level, `${where}: ${describe(error)}`)
  } catch {
    // Without the bridge the console is all there is
  }
}
