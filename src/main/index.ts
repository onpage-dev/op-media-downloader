import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import axios from 'axios'
import { BrowserWindow, IpcMainEvent, app, dialog, shell } from 'electron'
import installExtension, { VUEJS_DEVTOOLS } from 'electron-devtools-installer'
import Store from 'electron-store'
import fs from 'fs'
import fsPromises from 'fs/promises'
import { OpFileRaw } from 'onpage-js'
import path from 'path'
import { DownloadFilesPayload } from '../shared/electron-ipc-renderer-models'
import { ElectronIPC } from './electron-ipc'
import { processQueue } from './utils'

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
  event.sender.send('update-version-info', {
    current: 'v' + app.getVersion(),
    latest: next?.tag_name,
  })
})
ElectronIPC.on(
  'check-missing-tokens',
  (event, { config_id, remote_files, directory }) => {
    try {
      chechMissingTokens(event, config_id, remote_files, directory)
    } catch (error) {
      console.log('ERROR [on checkMissingToken]', error)
    } finally {
      event.sender.send('update-missing-tokens')
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

  initFolderStructure(directory)
  const base_path = path.normalize(directory)
  console.log(`fs.readdirSync(base_path)`, base_path)
  /** List of downloaded file names */
  const local_files = fs
    .readdirSync(base_path)
    .map(name => name.toLocaleLowerCase())

  const data_path = getDataPath(directory)
  console.log(`fs.readdirSync(data_path)`, data_path)
  /** List of downloaded tokens */
  const local_tokens = fs.readdirSync(data_path)

  if (!local_tokens.length) {
    console.log('All tokens missing')
    event.sender.send('update-missing-tokens-to-download', {
      config_id,
      missing_files: remote_files,
    })
    return
  }

  /** Check if missing token or file name */
  const missing_files = remote_files.filter(
    file =>
      !local_tokens.includes(file.token) ||
      !local_files.includes(file.name.toLocaleLowerCase()),
  )
  console.log(`${missing_files.length} tokens missing`)
  console.log(missing_files)
  event.sender.send('update-missing-tokens-to-download', {
    config_id,
    missing_files,
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

/** Files Download */
const queues: Map<string, (() => Promise<void>)[]> = new Map()
function emitDownloadProgress(
  event: Electron.IpcMainEvent,
  data: DownloadFilesPayload,
  jobs: (() => Promise<void>)[],
  stop?: boolean,
): void {
  data.loader.is_stopping = !jobs.length
  const progressEvent = data.loader
  if (stop) {
    progressEvent.downloading = false
    progressEvent.is_stopping = false
  }
  event.sender.send('update-download-progress', {
    config_id: data.config_id,
    progressEvent,
  })
}
function linkFile(linkPath: string, filePath: string): void {
  console.log('\n[Link START] File:')
  console.log(` - Source: ${filePath}`)
  console.log(` - Target: ${linkPath}`)

  /** Remove existing link if it exists */
  try {
    if (fs.existsSync(linkPath)) {
      console.log(`Removing existing link: ${linkPath}`)
      fs.unlinkSync(linkPath)
    }
  } catch (error) {
    console.log('Unlink failed, continuing with link creation:')
    console.error(error)
  }

  /** Attempt to create a hard link */
  try {
    console.log(`Creating hard link: ${filePath} -> ${linkPath}`)
    fs.linkSync(filePath, linkPath)
    console.log('[Link END] Linking file successful')
    return
  } catch (hardLinkError) {
    console.log('[Link FAILED] Falling back to soft copy')
    console.error(hardLinkError)
  }

  /** Soft copy fallback */
  try {
    console.log('Attempting soft copy with FICLONE')
    fs.copyFileSync(filePath, linkPath, fs.constants.COPYFILE_FICLONE)
    console.log('[Link END] Soft copy successful')
    return
  } catch (softCopyError) {
    console.log('[Soft Copy FAILED] Falling back to hard copy')
    console.error(softCopyError)
  }

  /** Hard copy fallback */
  try {
    console.log('Performing hard copy using read/write buffer')
    /** Set Buffer as any for type validation inside writeFileSync */
    const buffer: any = fs.readFileSync(filePath)
    fs.writeFileSync(linkPath, buffer)
    console.log('[Link END] Hard copy successful')
  } catch (hardCopyError) {
    console.error('[Hard Copy FAILED] All attempts to link/copy failed')
    console.error(hardCopyError)
  }
}
async function deleteOldLinks(
  links: OpFileRaw['name'][],
  new_files: Set<string>,
  link_map: { [key: OpFileRaw['name']]: OpFileRaw['token'] },
): Promise<void> {
  // Prepare the queue of deletion tasks
  const todo = links.map(link => async (): Promise<void> => {
    try {
      const name = path.basename(link)

      /** Folder containing tokens */
      if (name === 'data') return

      /** File still exists inside project so keep it */
      if (new_files.has(name)) return

      console.log(`fs.unlink(existing_link)`, link)
      await fs.promises.unlink(link)
      delete link_map[name]
    } catch (error) {
      console.error('Cannot delete file', error)
    }
  })

  await processQueue(todo, 10)
}
function createLinkAndUpdateMap(
  link_path: string,
  file_path: string,
  file_name: string,
  token: string,
  links_map: { [key: OpFileRaw['name']]: OpFileRaw['token'] },
  links_map_path: string,
): void {
  // Create the link
  linkFile(link_path, file_path)

  // Update the links map
  links_map[file_name] = token
  fs.writeFileSync(links_map_path, JSON.stringify(links_map))
  console.log(`[Create Link] Linked ${file_name} -> ${token}`)
}
function updateLoaderAndCleanUp(
  token: string,
  token_to_names: Map<string, string[]>,
  loader: { downloaded: number; failed: number },
  target: 'downloaded' | 'failed',
): void {
  const associated_names = token_to_names.get(token) || []
  loader[target] += associated_names.length
  token_to_names.delete(token)
  console.log(
    `[Loader Update] ${target.toUpperCase()}: ${
      associated_names.length
    } for token ${token}`,
  )
}
async function downloadFile(
  event: Electron.IpcMainEvent,
  data: DownloadFilesPayload,
  file: DownloadFilesPayload['files'][0],
  jobs: (() => Promise<void>)[],
  data_path: string,
  existing_tokens: OpFileRaw['token'][],
  links_map_path: string,
  links_map: { [key: OpFileRaw['name']]: OpFileRaw['token'] },
  active_downloads: Map<string, Promise<void>>,
  token_to_names: Map<string, string[]>,
): Promise<void> {
  const file_path = path.join(data_path, file.token)
  const link_path = path.join(path.normalize(data.directory), file.name)

  console.log(`[Download File] File: ${file.name}, Token: ${file.token}`)

  /** Add file name to the list of names for this token */
  if (!token_to_names.has(file.token)) {
    token_to_names.set(file.token, [])
  }
  token_to_names.get(file.token)!.push(file.name)

  /** If the token already exists in the data folder */
  if (existing_tokens.includes(file.token)) {
    console.log(`[Download File] Token already exists: ${file.token}`)
    data.loader.already_exists++

    /** Create the link for the existing token */
    createLinkAndUpdateMap(
      link_path,
      file_path,
      file.name,
      file.token,
      links_map,
      links_map_path,
    )
    return
  }

  if (!active_downloads.has(file.token)) {
    const downloadPromise = (async (): Promise<void> => {
      /** Remove all outdated links */
      Object.keys(links_map).forEach(link => {
        if (links_map[link] === file.name) {
          delete links_map[link]
        }
      })

      /** Download the file */
      try {
        console.log(`[Download Token] Downloading: ${file.token}`)
        await downloadUrlToFile(file.url, file_path)
      } catch (error) {
        console.error(`[Download Token] Failed for ${file.token}`, error)

        /** Increment failed counter for all associated file names */
        updateLoaderAndCleanUp(
          file.token,
          token_to_names,
          data.loader,
          'failed',
        )
        throw error
      }
    })()

    active_downloads.set(file.token, downloadPromise)

    // Clean up after the download is complete
    downloadPromise.finally(() => {
      active_downloads.delete(file.token)
    })
  }

  try {
    /** Wait for the download to complete */
    await active_downloads.get(file.token)

    /** Create links for all associated file names */
    createLinkAndUpdateMap(
      link_path,
      file_path,
      file.name,
      file.token,
      links_map,
      links_map_path,
    )

    /** Increment the downloaded counter by the number of file names for this token */
    updateLoaderAndCleanUp(
      file.token,
      token_to_names,
      data.loader,
      'downloaded',
    )
  } catch (error) {
    console.error(`[Create Link] Failed for ${file.name}`, error)

    /** Increment failed counter for all associated file names if linking fails */
    updateLoaderAndCleanUp(file.token, token_to_names, data.loader, 'failed')
  }

  /** Update progress */
  emitDownloadProgress(event, data, jobs)
}
async function downloadUrlToFile(
  fileUrl: string,
  filePath: string,
): Promise<void> {
  const tempPath = `${filePath}.download`
  console.log(`\n[Download] File: ${fileUrl} -> ${filePath}`)
  console.log(`[Temp Path] Temp Path for Download: ${tempPath}`)

  try {
    const response = await axios({
      method: 'GET',
      url: fileUrl,
      responseType: 'stream',
    })

    console.log(`[Download Stream] Writing to ${tempPath}`)
    const stream = fs.createWriteStream(`${filePath}.download`)

    return new Promise((resolve, reject) => {
      response.data.pipe(stream)

      stream.on('finish', () => {
        console.log(`[Download Stream] Finished writing to ${tempPath}`)
        stream.close(() => {
          console.log(`[Renaming] Temp: ${tempPath} -> Final: ${filePath}`)
          fs.renameSync(tempPath, filePath)
          resolve()
        })
      })

      stream.on('error', error => {
        console.error(`[Download Stream] Error:`, error)
        reject(error)
      })
    })
  } catch (error) {
    console.error('[Download] Failed to fetch URL:', error)
    throw error
  }
}
ElectronIPC.on('download-files', async (event, data) => {
  console.log(`[downloadFiles] triggered for folder ${data.directory}`)
  data.loader.downloading = true
  data.loader.total = data.files.length

  /** Check and init main folder structure */
  const directory = data.directory
  initFolderStructure(directory)

  /** Get existing tokens inside data path */
  const data_path = getDataPath(directory)
  const existing_tokens: OpFileRaw['token'][] = fs.readdirSync(data_path)

  /** Get existing links inside links path */
  const existing_links: OpFileRaw['name'][] = fs.readdirSync(directory)

  /**
   * Get the link.json file that defines the relation of all generated links
   * The file content is defined as Record<FileName, FileToken>
   */
  const links_map_path = path.join(data_path, 'link.json')
  const links_map: Record<string, string> = fs.existsSync(links_map_path)
    ? JSON.parse(fs.readFileSync(links_map_path, { encoding: 'utf-8' }))
    : {}

  /** Optionally delete old links */
  if (!data.keep_old_files) {
    await deleteOldLinks(
      existing_links,
      new Set(data.files.map(f => f.name)),
      links_map,
    )
  }

  /** Create download jobs */
  const active_downloads: Map<string, Promise<void>> = new Map()
  const token_to_names: Map<string, string[]> = new Map()
  const jobs = data.files.map(
    file => (): Promise<void> =>
      downloadFile(
        event,
        data,
        file,
        jobs,
        data_path,
        existing_tokens,
        links_map_path,
        links_map,
        active_downloads,
        token_to_names,
      ),
  )

  queues.set(data.config_id, jobs)

  console.log(`[downloadFiles] syncing ${data.files.length} files`)
  const concurrent_count =
    Number(store.get('user_properties.simultaneous_downloads')) || 1

  /** Process queue with limited concurrency */
  await processQueue(jobs, concurrent_count)

  /** Cleanup and finalize */
  queues.delete(data.config_id)
  emitDownloadProgress(event, data, jobs, true)

  console.log(` - Downloaded: ${data.loader.downloaded}`)
  console.log(` - Failed: ${data.loader.failed}`)
  console.log(` - Already exists: ${data.loader.already_exists}`)
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

/**
 * Checks if folder structure is valid
 * In case some folders are missing generates them
 */
function initFolderStructure(directory_path: string): void {
  const main_path = path.normalize(directory_path)
  const data_path = getDataPath(directory_path)

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
/** Returns normalized data folder path */
function getDataPath(directory: string): string {
  return path.normalize(path.join(path.normalize(directory), 'data'))
}

async function createWindow(): Promise<void> {
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

    // Install Vue Devtools
    try {
      await installExtension(VUEJS_DEVTOOLS)
      console.log('Vue Devtools installed!')
    } catch (err) {
      console.error('Failed to install Vue Devtools:', err)
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  await createWindow()

  app.on('activate', async function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) await createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
