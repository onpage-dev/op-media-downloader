/**
 * Main process entry. Placeholder while 2.0.0 is assembled: opens the window
 * and starts the engine.
 */
import { app, BrowserWindow, utilityProcess } from 'electron'
import path from 'path'

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
    },
  })
  window.on('ready-to-show', () => window.show())
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    await window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    await window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  const engine = utilityProcess.fork(path.join(__dirname, 'engine.js'), [], {
    serviceName: 'Media Downloader engine',
  })
  engine.postMessage({ kind: 'command', command: { type: 'init' } })
  await createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
