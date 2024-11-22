import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import axios from 'axios'
import { BrowserWindow, IpcMainEvent, app, dialog, shell } from 'electron'
import Store from 'electron-store'
import fs from 'fs'
import fsPromises from 'fs/promises'
import { cloneDeep } from 'lodash'
import { OpFileRaw } from 'onpage-js'
import path from 'path'
import { processQueue } from './utils'
import { ElectronIPC } from './electron-ipc'

export interface SyncProgressInfo {
  start_time: string
  downloading: boolean
  is_stopping: boolean
  total: number
  downloaded: number
  failed: number
  already_exists: number
}

const store = new Store({
  name: 'op-media-downloader-config',
  watch: true,
  clearInvalidConfig: true,
})
ElectronIPC.on('open-url', (event, url) => {
  event.preventDefault()
  shell.openExternal(url)
})
ElectronIPC.on('get-version-info', async event => {
  let next: undefined | { tag_name: string } = undefined
  try {
    event.preventDefault()
    next = (
      await axios(
        'https://api.github.com/repos/onpage-dev/op-media-downloader/releases/latest',
      )
    ).data
  } catch (error) {
    console.error(error)
  }
  event.sender.send(
    'update-version-info',
    cloneDeep({
      current: 'v' + app.getVersion(),
      latest: next?.tag_name,
    }),
  )
})
ElectronIPC.on(
  'check-missing-tokens',
  (event, { config_id, remote_files, directory }) => {
    try {
      chechMissingTokens(event, config_id, remote_files, directory)
    } catch (error) {
      console.log('ERROR [on checkMissingToken]', error)
    }
  },
)
function chechMissingTokens(
  event: IpcMainEvent,
  config_id: string,
  remote_files: OpFileRaw[],
  directory: string,
): void {
  console.log(`[checkMissingTokens] triggered for path ${directory}`)

  generateMissingFolder(directory)
  const base_path = path.normalize(directory)
  console.log(`fs.readdirSync(base_path)`, base_path)
  const local_files = fs.readdirSync(base_path)

  const data_path = getDataPath(directory)
  console.log(`fs.readdirSync(data_path)`, data_path)
  const local_tokens = fs.readdirSync(data_path)

  if (!local_tokens.length) {
    console.log('All tokens missing')
    event.sender.send('update-missing-tokens-to-download', {
      config_id,
      missing_files: remote_files,
    })
    return
  }

  // Check if missing token or file name
  const difference = remote_files.filter(
    file =>
      !local_tokens.includes(file.token) || !local_files.includes(file.name),
  )
  console.log(`${difference.length} tokens missing`)
  console.log(difference)
  event.sender.send('update-missing-tokens-to-download', {
    config_id,
    missing_files: difference,
  })
}
ElectronIPC.on('open-path', (_event, path_to_open) => {
  console.log(`[openPath] triggered for path ${path_to_open}`)
  shell.openPath(path.normalize(path_to_open))
})

ElectronIPC.on('stop-download', (_event, config_id) => {
  console.log('[download-stop] stopping download for config', config_id)
  queues.get(config_id)?.splice(0)
})
ElectronIPC.on('delete-folder', async (_event, folder_path: string) => {
  try {
    console.log(`[deleteFolder] triggered for path ${folder_path}`)
    await fsPromises.rm(path.normalize(folder_path), { recursive: true })
  } catch (error) {
    console.log(error)
  }
})
ElectronIPC.on(
  'delete-removed-files-from-remote',
  (
    _event,
    {
      remote_files,
      directory,
    }: { remote_files: OpFileRaw[]; directory: string },
  ) => {
    console.log(
      `[deleteRemovedFilesFromRemote] triggered for path ${directory}`,
    )
    const links_path = path.normalize(directory)
    const data_path = getDataPath(directory)
    const tokens_to_delete = fs
      .readdirSync(data_path)
      .filter(token => !remote_files.find(f => f.token == token))
    console.log(
      `[deleteRemovedFilesFromRemote] ${tokens_to_delete.length} tokens to remove`,
    )

    const links_to_delete = fs
      .readdirSync(links_path)
      .filter(
        name => name !== 'data' && !remote_files.find(f => f.name == name),
      )
    console.log(
      `[deleteRemovedFilesFromRemote] ${links_to_delete.length} links to remove`,
    )

    tokens_to_delete.forEach((token: string) => {
      try {
        const p = path.normalize(`${directory}/data/${token}`)
        console.log(`fs.unlinkSync(p)`)
        fs.unlinkSync(p)
      } catch (error) {
        console.log(`Error deleting ${token}`)
        console.log(error)
      }
    })

    links_to_delete.forEach((name: string) => {
      try {
        const p = path.normalize(`${directory}/${name}`)
        console.log(`fs.unlinkSync(p)`)
        fs.unlinkSync(p)
      } catch (error) {
        console.log(`Error deleting ${name}`)
        console.log(error)
      }
    })
  },
)

const queues: Map<string, (() => Promise<void>)[]> = new Map()

ElectronIPC.on('download-files', async (event, data) => {
  console.log(`[downloadFiles] triggered for folder ${data.directory}`)
  data.loader.downloading = true

  data.loader.total = data.files.length
  const to_download = cloneDeep(data.files).map(file => file.token)
  const dataPath = getDataPath(data.directory)
  generateMissingFolder(data.directory)
  const links_path = dataPath + '/link.json'

  console.log(`fs.readdirSync(dataPath)`)
  const existing_files = fs.readdirSync(dataPath)

  console.log(`fs.readdirSync(data.directory)`)
  const existing_links = fs.readdirSync(data.directory)

  console.log(`fs.existsSync(links_path)`)
  const link_map = fs.existsSync(links_path)
    ? JSON.parse(fs.readFileSync(links_path, { encoding: 'utf-8' }))
    : {}

  const emit_progress = (): void => {
    data.loader.is_stopping = !jobs.length
    event.sender.send('update-download-progress', {
      config_id: data.config_id,
      progressEvent: data.loader,
    })
  }

  const do_link = (linkPath: string, filePath: string): void => {
    console.log(' ')
    console.log('[Link START] File:')
    console.log(` - ${filePath}`)
    console.log(` - ${linkPath}`)
    try {
      if (fs.existsSync(linkPath)) {
        console.log(`fs.unlinkSync(linkPath)`)
        fs.unlinkSync(linkPath)
      }
    } catch (error) {
      console.log('Unlink failed:')
      console.log(error)
    }

    try {
      console.log(`fs.linkSync(filePath, linkPath)`)
      fs.linkSync(filePath, linkPath)
    } catch (error) {
      console.log('[Link FAILED] Using Soft Copy as fallback')
      console.log(error)
      try {
        console.log(
          'fs.copyFileSync(filePath, linkPath, fs.constants.COPYFILE_FICLONE)',
        )
        fs.copyFileSync(filePath, linkPath, fs.constants.COPYFILE_FICLONE)
      } catch (error) {
        console.log('[Soft Copy FAILED] Using hard copy as fallback')
        console.log(error)
        console.log(' ')
        console.log(`console.log(fs.readFileSync(filePath))`)

        const buffer: Uint8Array = fs.readFileSync(filePath) as any
        fs.writeFileSync(linkPath, buffer)
      }
    }
    console.log('[Link END] Linking file successful')
  }

  // Delete old links
  if (!data.keep_old_files) {
    existing_links.forEach(existing_link => {
      const filename = path.basename(existing_link)
      if (filename == 'data') return
      if (!data.files.find(f => f.name == filename)) {
        console.log('deleting old link', existing_link)
        try {
          console.log(`fs.unlinkSync(existing_link)`)
          fs.unlinkSync(existing_link)
        } catch (error) {
          console.log('cannot delete file', error)
        }
        delete link_map[filename]
      }
    })
  }

  const download_file = async (file: {
    url: string
    token: string
    name: string
  }): Promise<void> => {
    /** Create Path */
    const filePath = path.normalize(`${dataPath}/${file.token}`)
    const linkPath = path.normalize(`${data.directory}/${file.name}`)

    if (!existing_files.includes(file.token)) {
      /** Invalidate all links pointing to the file we have to download */
      for (const i in link_map) {
        if (link_map[i] == file.token) {
          delete link_map[i]
        }
      }

      console.log(' ')
      console.log('[download] Downloadinf file:')
      console.log(` - ${file.url}`)
      console.log(` - ${filePath}`)
      try {
        await downloadUrlToFile(file.url, filePath)
        console.log('[download] Downloadinf complete')
        data.loader.downloaded++
      } catch (error) {
        console.log('[download] Downloadinf failed:')
        console.log(error)
        data.loader.failed++
        emit_progress()
        return
      }
    } else {
      data.loader.already_exists++
    }

    /** Download the file */
    if (link_map[file.name] != file.token) {
      try {
        do_link(linkPath, filePath)
        link_map[file.name] = file.token
        console.log(`fs.writeFileSync(links_path, JSON.stringify(link_map))`)
        fs.writeFileSync(links_path, JSON.stringify(link_map))
      } catch (error) {
        console.log('[download] cannot copy file:', error)
        data.loader.failed++
      }
    }

    // Update progress
    emit_progress()
  }

  const jobs = data.files.map(
    file => (): Promise<void> => download_file(cloneDeep(file)),
  )

  queues.set(data.config_id, jobs)

  console.log(`[downloadFiles] sync ${to_download.length} files`)
  const concurrentCount =
    Number(store.get('user_properties.simultaneous_downloads')) || 1

  await processQueue(jobs, concurrentCount)

  data.loader.downloading = false
  queues.delete(data.config_id)
  event.sender.send('update-download-progress', {
    config_id: data.config_id,
    progressEvent: data.loader,
  })

  console.log(` - downloaded: ${data.loader.downloaded}`)
  console.log(` - failed: ${data.loader.failed}`)
  console.log(` - already_exists: ${data.loader.already_exists}`)
  console.log('[downloadFiles] sync over')
})
ElectronIPC.handle('pick-folder-path', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  })
  return path.normalize(res.filePaths[0])
})
ElectronIPC.handle('electron-store-set', async (_event, { key, val }) => {
  console.log('[electron-store-set] setting', key, 'as', val)
  store.set(key, val)
  return store.get(key)
})
ElectronIPC.handle('electron-store-get', (_event, key) => {
  return store.get(key)
})
ElectronIPC.handle('electron-store-has', async (_event, key) => {
  return store.has(key)
})
ElectronIPC.handle('electron-store-delete', async (_Event, key) => {
  store.delete(key)
  return !store.has(key)
})

async function downloadUrlToFile(url: string, path: string): Promise<void> {
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
  })

  try {
    console.log(`fs.createWriteStream(${path}.download))`)
    response.data.pipe(fs.createWriteStream(`${path}.download`))
  } catch (error) {
    console.log('error creating write stream', error)
  }

  return new Promise((resolve, reject) => {
    response.data.on('end', () => {
      console.log(`fs.renameSync(${path}.download, ${path})`)
      fs.renameSync(`${path}.download`, path)
      resolve()
    })

    response.data.on('error', (error: any) => reject(error))
  })
}
function generateMissingFolder(directory: string): void {
  const main_path = path.normalize(directory)
  const data_path = path.normalize(`${directory}/data`)

  console.log(`fs.existsSync(main_path))`)
  if (!fs.existsSync(main_path)) {
    console.log(`fs.mkdirSync(main_path)`)
    fs.mkdirSync(main_path)
  }

  console.log(`fs.existsSync(data_path))`)
  if (!fs.existsSync(data_path)) {
    console.log(`fs.mkdirSync(data_path)`)
    fs.mkdirSync(data_path)
  }
}
function getDataPath(directory: string): string {
  return path.normalize(`${directory}/data`)
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    minWidth: 800,
    height: 670,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,

    ...(process.platform === 'linux'
      ? {
          icon: path.join(__dirname, '../../build/icon.png'),
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  store.onDidAnyChange(newValue => {
    mainWindow.webContents.send('electron-store-changed', newValue)
  })

  mainWindow.webContents.setWindowOpenHandler(details => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
