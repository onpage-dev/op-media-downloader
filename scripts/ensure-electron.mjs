/**
 * Electron 45 no longer downloads its binary during install: the download
 * happens on the first require('electron'). electron-vite never does that
 * require. It reads node_modules/electron/path.txt and, when the file is
 * missing, exits with "Electron uninstall". dev and preview need the binary
 * fetched first. install.js does nothing when the binary is already there.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/electron/install.js')], {
  cwd: root,
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
