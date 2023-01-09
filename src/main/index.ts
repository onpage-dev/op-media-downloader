import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import axios from 'axios'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import Store from 'electron-store'
import fs from 'fs'
import { cloneDeep } from 'lodash'
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
ipcMain.on('loadFiles', (event, path) => {
  console.log(`[loadFiles] triggered for path ${path}`)

  if (!fs.existsSync(path)) {
    fs.mkdirSync(path)
  }
  const files = fs.readdirSync(path)

  console.log(`[loadFiles] loaded ${files.length} files`)
  event.sender.send('loadedFiles', files)
})
ipcMain.on(
  'downloadFiles',
  (
    event,
    data: {
      files: { url: string; token: string; name: string }[]
      directory: string
      loader: {
        downloading: boolean
        total: { url: string; token: string; name: string }[]
        already_exists: { url: string; token: string; name: string }[]
        downloaded: { url: string; token: string; name: string }[]
        failed: { url: string; token: string; name: string }[]
      }
    },
  ) => {
    console.log(`[downloadFiles] triggered for folder ${data.directory}`)

    data.loader.total = cloneDeep(data.files)
    const to_download = cloneDeep(data.files).map(file => file.token)

    const download_file = (file: {
      url: string
      token: string
      name: string
    }): void => {
      const dataPath = path.normalize(`${data.directory}/data`)
      const filePath = path.normalize(`${dataPath}/${file.token}`)

      if (fs.existsSync(filePath)) {
        fs.link(
          filePath,
          path.normalize(`${data.directory}/${file.name}`),
          () => {},
        )
        data.loader.already_exists.push(file)
        emit_progress(file)
        return
      }
      if (!fs.existsSync(data.directory)) {
        fs.mkdirSync(data.directory)
      }
      if (!fs.existsSync(dataPath)) {
        fs.mkdirSync(dataPath)
      }

      const url = file.url
      axios({
        method: 'GET',
        url,
        responseType: 'stream',
      })
        .then(response => {
          response.data.pipe(fs.createWriteStream(filePath))

          response.data.on('end', () => {
            data.loader.downloaded.push(file)
            fs.link(
              filePath,
              path.normalize(`${data.directory}/${file.name}`),
              () => {},
            )
            emit_progress(file)
          })

          response.data.on('error', error => {
            console.log(error)
            data.loader.failed.push(file)
            emit_progress(file)
          })
        })
        .catch(() => {
          if (data.loader.failed.findIndex(f => f.token == file.token) <= 0) {
            data.loader.failed.push(file)
          }
          emit_progress(file)
        })
    }

    const emit_progress = (file: {
      url: string
      token: string
      name: string
    }): void => {
      const to_download_idx = to_download.indexOf(file.token)
      if (to_download_idx >= 0) {
        to_download.splice(to_download_idx, 1)
      }

      event.sender.send('downloadProgress', data.loader)
      if (!to_download.length) {
        console.log(` - downloaded: ${data.loader.downloaded.length}`)
        console.log(` - failed: ${data.loader.failed.length}`)
        console.log(` - already_exists: ${data.loader.already_exists.length}`)
        console.log('[downloadFiles] sync over')
        event.sender.send('downloadEnd')
      }
    }

    console.log(`[downloadFiles] sync ${to_download.length} files`)
    data.files.forEach(file => download_file(file))
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
