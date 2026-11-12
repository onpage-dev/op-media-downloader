/**
 * Packages the macOS app. Xcode 26's actool compiles build/icon.icon into the
 * light, dark and tinted icon. Without that actool, electron-builder stops;
 * the icns drawn for every macOS is used instead. ARCH=arm64 or ARCH=x64
 * selects the arch, as the release workflow does.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** actool --version is a plist. Xcode 26 is the first actool that compiles .icon files. */
export function actoolSupportsIconComposer(output) {
  const version = output.match(/<key>short-bundle-version<\/key>\s*<string>([^<]+)<\/string>/)
  if (!version) return false
  const major = Number.parseInt(version[1], 10)
  return Number.isFinite(major) && major >= 26
}

function iconComposerAvailable() {
  try {
    const output = execFileSync('actool', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return actoolSupportsIconComposer(output)
  } catch {
    return false
  }
}

export function builderArgs() {
  const args = ['--mac', '--config']
  if (process.env.ARCH) args.push(`--${process.env.ARCH}`)
  if (!iconComposerAvailable()) args.push('-c.mac.icon=build/icon.icns')
  return args
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = builderArgs()
  if (args.includes('-c.mac.icon=build/icon.icns')) {
    console.log('No Xcode 26 actool; packaging with build/icon.icns')
  }
  const result = spawnSync(path.join(root, 'node_modules/.bin/electron-builder'), args, {
    cwd: root,
    stdio: 'inherit',
  })
  process.exit(result.status ?? 1)
}
