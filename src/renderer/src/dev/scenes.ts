/**
 * Scenes for the captures, from the URL, when the renderer runs alone in a
 * browser: `theme=dark`, `select=<id>`, `tab=<tab>`, `filter=<filter>`,
 * `query=<text>`, `wizard=<step>` (with `folder`, `token`), `dialog=<kind>`,
 * `settings=<section>`, `menu=1` (the menu of the selected row), `dropping=1`.
 */
import { nextTick, watch } from 'vue'
import type { InspectorTab, SettingsSection } from '@shared/desktop-api'
import type { ProjectFilter } from '@shared/status'
import { app, ask, openSettings, select, type DialogState } from '../store'

const ready = (): Promise<void> =>
  new Promise(resolve => {
    if (app.ready) return resolve()
    const stop = watch(
      () => app.ready,
      value => {
        if (!value) return
        stop()
        resolve()
      },
    )
  })

const SPARK = [0.4, 0.55, 0.5, 0.7, 0.62, 0.8, 0.74, 0.9, 0.85, 0.78, 0.88, 0.82]

export async function playScene(): Promise<void> {
  const params = new URLSearchParams(location.search)
  const get = (name: string): string | undefined => params.get(name) ?? undefined
  const theme = get('theme')
  if (theme == 'dark' || theme == 'light') document.documentElement.dataset.theme = theme
  await ready()
  // The speed of the last minute, as the sparkline has it after a while
  for (const project of app.projects) {
    const speed = project.runtime.phase == 'downloading' ? project.runtime.progress?.speed_bps : undefined
    if (speed) app.speeds[project.id] = SPARK.map(v => (v * speed) / SPARK[SPARK.length - 1])
  }
  if (get('filter')) app.filter = get('filter') as ProjectFilter
  if (get('query')) app.query = get('query')!
  if (get('select')) select(get('select'))
  if (get('tab')) app.tab = get('tab') as InspectorTab
  if (params.has('wizard')) app.wizard = { folder: get('folder'), step: Number(get('wizard')) || 0, token: get('token') }
  if (get('dialog')) ask(get('dialog') as DialogState['kind'])
  if (get('settings')) openSettings(get('settings') as SettingsSection)
  if (params.has('dropping')) app.dropping = true
  if (params.has('menu')) {
    await nextTick()
    const row = document.querySelector('[role=row][aria-selected=true]')?.getBoundingClientRect()
    if (row && app.selectedId) app.menu = { id: app.selectedId, x: row.left + 380, y: row.top + row.height / 2 }
  }
}
