import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import axios from 'axios'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import Store from 'electron-store'
import fs from 'fs'
import path from 'path'

const store = new Store({
  name: 'op-media-downloader-config',
  watch: true,
  clearInvalidConfig: true,
})
ipcMain.on('openPath', (_event, p) => {
  shell.openPath(path.normalize(p))
})
ipcMain.on('loadFiles', (event, path) => {
  if (!fs.existsSync(path)) {
    fs.mkdirSync(path)
  }
  const files = fs.readdirSync(path)
  console.log(files)
  event.sender.send('loadedFiles', files)
})
ipcMain.on('downloadFile', (event, data) => {
  const dataPath = path.normalize(`${data.directory}/data`)
  const filePath = path.normalize(`${dataPath}/${data.token}`)
  if (fs.existsSync(filePath)) {
    fs.link(
      filePath,
      path.normalize(`${data.directory}/${data.name}`),
      () => {},
    )
    return event.sender.send('fileAlreadyExists')
  }

  if (!fs.existsSync(data.directory)) {
    fs.mkdirSync(data.directory)
  }
  if (!fs.existsSync(dataPath)) {
    fs.mkdirSync(dataPath)
  }

  const url = data.url
  axios({
    method: 'GET',
    url,
    responseType: 'stream',
  })
    .then(response => {
      response.data.pipe(fs.createWriteStream(filePath))

      const totalSize = response.headers['content-length']
      let downloaded = 0

      response.data.on('data', data => {
        downloaded += Buffer.byteLength(data)
        event.sender.send('downloadProgress', {
          total: totalSize,
          loaded: downloaded,
        })
      })
      response.data.on('end', () => {
        event.sender.send('downloadEnd')
        fs.link(
          filePath,
          path.normalize(`${data.directory}/${data.name}`),
          () => {},
        )
      })
      response.data.on('error', error => {
        event.sender.send('downloadError', error)
      })
    })
    .catch(error => {
      event.sender.send('downloadError', error)
    })
})
ipcMain.handle('pick-folder-path', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  })
  return path.normalize(res.filePaths[0])
})
ipcMain.handle('electron-store-set', async (_event, key: string, val: any) => {
  console.log('setting', key, 'as', val)
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
