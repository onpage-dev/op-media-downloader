/**
 * `opmd` beside the app in its installers: builds it for the target Tauri is
 * bundling (TAURI_ENV_TARGET_TRIPLE, set for beforeBuildCommand) and puts it
 * where `bundle.externalBin` looks for it, src-tauri/binaries/opmd-<target>.
 * Tauri then installs it next to the app: the install folder on Windows (the
 * installer puts it on the PATH), Contents/MacOS in the .app, /usr/bin with
 * the .deb. Run by `tauri build --config src-tauri/tauri.bundle.conf.json`.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
  .match(/^host: (.+)$/m)[1]
  .trim()
const target = process.env.TAURI_ENV_TARGET_TRIPLE || process.env.OPMD_TARGET || host
const windows = target.includes('windows')

// The host's target builds where the app does (target/release), sharing its dependencies
const args = ['build', '--release', '-p', 'opmd']
if (process.env.CI) args.push('--locked')
if (target != host) args.push('--target', target)
execFileSync('cargo', args, { cwd: ROOT, stdio: 'inherit' })

const exe = windows ? '.exe' : ''
const built = path.join(ROOT, 'target', ...(target != host ? [target] : []), 'release', `opmd${exe}`)
const binaries = path.join(ROOT, 'src-tauri', 'binaries')
mkdirSync(binaries, { recursive: true })
copyFileSync(built, path.join(binaries, `opmd-${target}${exe}`))
console.log(`opmd for ${target} ready for the bundle`)
