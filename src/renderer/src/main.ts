/**
 * The renderer: the main window, or the tray panel at `#/tray`, or the
 * settings alone at `#/settings`. In the app `window.desktop` is the app's
 * commands (`desktop/tauri.ts`); in development without the app (the renderer
 * alone in a browser) a stand-in API with the projects of the mockup takes
 * its place; it never reaches a production build. The page's own errors (a
 * component that throws, a promise nobody awaited) go to the app's log.
 */
// The app's styles first: Tailwind's licence line has to open the stylesheet to stay in the minified one
// (Font Awesome's rules have no layer: they win over Tailwind's in any order)
import './styles/app.css'
import { config } from '@fortawesome/fontawesome-svg-core'
import '@fortawesome/fontawesome-svg-core/styles.css'
import { createApp, type Component } from 'vue'
import { i18n } from './i18n'
import { logError } from './lib/errors'
import { vTooltip } from './lib/tooltip'

config.autoAddCss = false

window.addEventListener('unhandledrejection', event => logError('unhandled rejection', event.reason))
window.addEventListener('error', event => logError('uncaught error', event.error ?? event.message))

async function start(): Promise<void> {
  if (window.__TAURI_INTERNALS__) (await import('./desktop/tauri')).installTauriDesktop()
  const alone = import.meta.env.DEV && !window.desktop
  if (alone) (await import('./dev/fake-desktop')).installFakeDesktop()
  const route = location.hash
  const root: Component = route.startsWith('#/tray')
    ? (await import('./TrayView.vue')).default
    : route.startsWith('#/settings')
      ? (await import('./SettingsView.vue')).default
      : (await import('./MainWindow.vue')).default
  const vue = createApp(root).use(i18n).directive('tooltip', vTooltip)
  vue.config.errorHandler = (error, _instance, info) => logError(`vue (${info})`, error)
  vue.mount('#app')
  if (alone) void (await import('./dev/scenes')).playScene()
}

void start().catch(error => logError('start', error))
