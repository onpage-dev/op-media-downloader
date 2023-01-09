import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import axios from 'axios'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import Store from 'electron-store'
import fs from 'fs'
import fsPromises from 'fs/promises'
import { cloneDeep } from 'lodash'
import { OpFileRaw } from 'onpage-js'
import path from 'path'

const store = new Store({
  name: 'op-media-downloader-config',
  watch: true,
  clearInvalidConfig: true,
})
ipcMain.on('openPath', (_event, p) => {
  console.log(`[openPath] triggered for path ${p}`)
  shell.openPath(path.normalize(p))
})
ipcMain.on('deleteFolder', async (_event, path: string) => {
  try {
    console.log(`[deleteFolder] triggered for path ${path}`)
    await fsPromises.rm(path.normalize(path), { recursive: true })
  } catch (error) {
    console.log(error)
  }
})
ipcMain.on(
  'deleteRemovedFilesFromRemote',
  (_event, remote_files: OpFileRaw[], directory: string) => {
    console.log(
      `[deleteRemovedFilesFromRemote] triggered for path ${directory}`,
    )
    const links_path = path.normalize(directory)
    const data_path = path.normalize(`${directory}/data`)
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
        fs.unlinkSync(p)
      } catch (error) {
        console.log(`Error deleting ${token}`)
        console.log(error)
      }
    })

    links_to_delete.forEach((name: string) => {
      try {
        const p = path.normalize(`${directory}/${name}`)
        fs.unlinkSync(p)
      } catch (error) {
        console.log(`Error deleting ${name}`)
        console.log(error)
      }
    })
  },
)

ipcMain.on(
  'downloadFiles',
  async (
    event,
    config_id,
    data: {
      files: { url: string; token: string; name: string }[]
      directory: string
      loader: {
        downloading: boolean
        total: number
        already_exists: number
        downloaded: number
        failed: number
      }
    },
  ) => {
    console.log(`[downloadFiles] triggered for folder ${data.directory}`)

    data.loader.total = data.files.length
    const to_download = cloneDeep(data.files).map(file => file.token)
    const dataPath = path.normalize(`${data.directory}/data`)

    // Create the base folder directory
    if (!fs.existsSync(data.directory)) {
      fs.mkdirSync(data.directory)
    }
    // Create the data directory
    if (!fs.existsSync(dataPath)) {
      fs.mkdirSync(dataPath)
    }

    const existing_files = fs.readdirSync(dataPath)

    const emit_progress = (file: {
      url: string
      token: string
      name: string
    }): void => {
      const to_download_idx = to_download.indexOf(file.token)
      if (to_download_idx >= 0) {
        to_download.splice(to_download_idx, 1)
      }

      event.sender.send('downloadProgress', config_id, data.loader)
      if (!to_download.length) {
        console.log(` - downloaded: ${data.loader.downloaded}`)
        console.log(` - failed: ${data.loader.failed}`)
        console.log(` - already_exists: ${data.loader.already_exists}`)
        console.log('[downloadFiles] sync over')
        event.sender.send('downloadEnd', config_id)
      }
    }

    const download_file = async (file: {
      url: string
      token: string
      name: string
    }): Promise<void> => {
      console.log(
        '[download] Start file download',
        file.token,
        process.memoryUsage().heapUsed / 1024 / 1024 / 1024 + ' GB',
      )

      // Create the file path
      const filePath = path.normalize(`${dataPath}/${file.token}`)
      const linkPath = path.normalize(`${data.directory}/${file.name}`)

      // Check if the file already exists
      if (existing_files.includes(file.token)) {
        console.log('[download] File exists', file.token)
        fs.link(filePath, linkPath, () => {})
        data.loader.already_exists++
        emit_progress(file)
        return
      }

      // Download the file
      try {
        console.log('[download] Streaming url to file', file.token)
        await downloadUrlToFile(file.url, filePath)
        console.log('[download] stream complete', file.token)

        // Link the file and return
        fs.link(filePath, linkPath, () => {})
        data.loader.downloaded++
        emit_progress(file)
      } catch (error) {
        console.log('[download] cannot download file:', error)
        data.loader.failed++
        emit_progress(file)
      }
    }

    console.log(`[downloadFiles] sync ${to_download.length} files`)
    for (const file of data.files) {
      await download_file(file)
    }
  },
)
ipcMain.handle('pick-folder-path', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  })
  return path.normalize(res.filePaths[0])
})
ipcMain.handle('electron-store-set', async (_event, key: string, val: any) => {
  console.log('[electron-store-set] setting', key, 'as', val)
  store.set(key, val)
  return store.get(key)
})
ipcMain.handle('electron-store-get', (_event, key: string) => {
  return store.get(key)
})
ipcMain.handle('electron-store-has', async (_event, key: string) => {
  return store.has(key)
})
ipcMain.handle('electron-store-delete', async (_Event, key: string) => {
  store.delete(key)
  return !store.has(key)
})

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
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
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.

async function downloadUrlToFile(url: string, path: string): Promise<void> {
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
  })
  response.data.pipe(fs.createWriteStream(path))

  return new Promise((resolve, reject) => {
    response.data.on('end', () => {
      resolve()
    })

    response.data.on('error', (error: any) => {
      reject(error)
    })
  })
}
