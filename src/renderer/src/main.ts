/**
 * The renderer: the main window, or the tray panel at `#/tray`, or the
 * settings alone at `#/settings`. In development without the preload (the
 * renderer alone in a browser) a stand-in API with the projects of the mockup
 * takes its place; it never reaches a production build.
 */
import { config } from '@fortawesome/fontawesome-svg-core'
import '@fortawesome/fontawesome-svg-core/styles.css'
import { createApp, type Component } from 'vue'
import { i18n } from './i18n'
import { vTooltip } from './lib/tooltip'
import './styles/app.scss'

config.autoAddCss = false

async function start(): Promise<void> {
  const alone = import.meta.env.DEV && !window.desktop
  if (alone) (await import('./dev/fake-desktop')).installFakeDesktop()
  const route = location.hash
  const root: Component = route.startsWith('#/tray')
    ? (await import('./TrayView.vue')).default
    : route.startsWith('#/settings')
      ? (await import('./SettingsView.vue')).default
      : (await import('./MainWindow.vue')).default
  createApp(root).use(i18n).directive('tooltip', vTooltip).mount('#app')
  if (alone) (await import('./dev/scenes')).playScene()
}

void start()
