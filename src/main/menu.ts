/**
 * The application menu exists only on macOS, where users expect it (and the
 * Edit menu makes copy and paste work). The renderer handles the shortcuts on
 * every platform: the menu only shows them (`registerAccelerator: false`), so
 * an action never runs twice. The Windows jump list offers two tasks.
 */
import { app, Menu, MenuItemConstructorOptions } from 'electron'
import { AppCommand } from '../shared/desktop-api'
import { AppLanguage } from '../shared/models'
import { texts } from './i18n'

export function setupMenu(language: AppLanguage, send: (command: AppCommand) => void): void {
  if (process.platform != 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const t = texts(language).menu
  const template: MenuItemConstructorOptions[] = [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: t.settings,
          accelerator: 'Cmd+,',
          registerAccelerator: false,
          click: () => send({ type: 'open_settings' }),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: t.file,
      submenu: [
        {
          label: t.new_project,
          accelerator: 'Cmd+N',
          registerAccelerator: false,
          click: () => send({ type: 'new_project' }),
        },
        {
          label: t.open_folder,
          accelerator: 'Cmd+O',
          registerAccelerator: false,
          click: () => send({ type: 'open_folder_selected' }),
        },
        { type: 'separator' },
        {
          label: t.find,
          accelerator: 'Cmd+F',
          registerAccelerator: false,
          click: () => send({ type: 'focus_search' }),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: t.sync,
      submenu: [
        {
          label: t.sync_selected,
          accelerator: 'Cmd+R',
          registerAccelerator: false,
          click: () => send({ type: 'sync_selected' }),
        },
        {
          label: t.sync_all,
          accelerator: 'Shift+Cmd+R',
          registerAccelerator: false,
          click: () => send({ type: 'sync_all' }),
        },
        { type: 'separator' },
        { label: t.download, click: () => send({ type: 'download_selected' }) },
        { label: t.stop, click: () => send({ type: 'stop_selected' }) },
      ],
    },
    ...(app.isPackaged ? [] : [{ label: 'View', submenu: [{ role: 'toggleDevTools' } as MenuItemConstructorOptions] }]),
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Jump list tasks re-launch the app with `--command=…`, handled by the single instance */
export function setupJumpList(language: AppLanguage): void {
  if (process.platform != 'win32' || !app.isPackaged) return
  const t = texts(language).menu
  app.setUserTasks([
    {
      program: process.execPath,
      arguments: '--command=sync_all',
      iconPath: process.execPath,
      iconIndex: 0,
      title: t.sync_all,
      description: t.sync_all_task,
    },
    {
      program: process.execPath,
      arguments: '--command=new_project',
      iconPath: process.execPath,
      iconIndex: 0,
      title: t.new_project.replace('…', ''),
      description: t.new_project_task,
    },
  ])
}

/** The command passed on the command line by the jump list, if any */
export function commandFromArgv(argv: string[]): AppCommand | undefined {
  const arg = argv.find(value => value.startsWith('--command='))
  switch (arg?.slice('--command='.length)) {
    case 'sync_all':
      return { type: 'sync_all' }
    case 'new_project':
      return { type: 'new_project' }
  }
  return undefined
}
