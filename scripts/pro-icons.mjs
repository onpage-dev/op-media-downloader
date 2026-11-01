/**
 * The Font Awesome Pro light icons of the On Page design system, for builds
 * made with an On Page token: every icon that src/renderer/src/lib/icons/free.ts
 * exports, read from the Font Awesome registry and written to
 * src/renderer/src/lib/icons/pro.generated.ts. That file is not in git: Pro
 * icons may be embedded in the app, not published in an open-source
 * repository. Without a token nothing happens and the app uses the Font
 * Awesome Free icons.
 *
 * The token: FONTAWESOME_NPM_AUTH_TOKEN, or `//npm.fontawesome.com/:_authToken=…`
 * in the user's .npmrc. `--required` fails without one (release builds).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ICONS = path.join(ROOT, 'src/renderer/src/lib/icons')
const OUT = path.join(ICONS, 'pro.generated.ts')
const REGISTRY = 'https://npm.fontawesome.com'
const PRO = { name: '@fortawesome/pro-light-svg-icons', version: '7.3.1' }
/** The On Page kit: its custom icons (the network folder) */
const KIT = { name: '@awesome.me/kit-6d2a188266', version: '1.0.165' }
const required = process.argv.includes('--required')

function token() {
  if (process.env.FONTAWESOME_NPM_AUTH_TOKEN?.trim()) return process.env.FONTAWESOME_NPM_AUTH_TOKEN.trim()
  const npmrc = path.join(os.homedir(), '.npmrc')
  if (!existsSync(npmrc)) return undefined
  const value = /^\/\/npm\.fontawesome\.com\/:_authToken\s*=\s*(\S+)/m.exec(readFileSync(npmrc, 'utf8'))?.[1]
  // `${VAR}` in .npmrc means the variable, as npm reads it
  return value?.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '').trim() || undefined
}

/** The files of an npm tarball (`package/` stripped), by path */
function untar(tgz) {
  const tar = gunzipSync(tgz)
  const files = new Map()
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512)
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '')
    const name = field(0, 100)
    if (!name) break
    const prefix = field(345, 155)
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1)
    const data = tar.subarray(at + 512, at + 512 + size)
    if (type == '0' || type == '') files.set((prefix ? `${prefix}/${name}` : name).replace(/^package\//, ''), data)
    at += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

async function fetchPackage(pkg, auth) {
  const headers = { authorization: `Bearer ${auth}` }
  const meta = await fetch(`${REGISTRY}/${pkg.name.replace('/', '%2f')}`, {
    headers,
    signal: AbortSignal.timeout(60_000),
  })
  if (!meta.ok) throw new Error(`${pkg.name}: HTTP ${meta.status}`)
  const tarball = (await meta.json()).versions?.[pkg.version]?.dist?.tarball
  if (!tarball) throw new Error(`${pkg.name}@${pkg.version} not found`)
  // The token goes to the Font Awesome registry only, whatever the metadata says
  if (new URL(tarball).origin != new URL(REGISTRY).origin) throw new Error(`${pkg.name}: tarball outside ${REGISTRY}`)
  const res = await fetch(tarball, { headers, signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`${pkg.name}@${pkg.version}: HTTP ${res.status}`)
  return untar(Buffer.from(await res.arrayBuffer()))
}

/** `faArrowsRotate.js` of a Pro icon package */
function fromIconModule(text) {
  const value = name => new RegExp(`var ${name} = ('([^']*)'|\\d+)`).exec(text)
  const string = name => value(name)?.[2]
  const number = name => Number(value(name)?.[1])
  return [
    string('prefix'),
    string('iconName'),
    [number('width'), number('height'), [], string('unicode'), string('svgPathData')],
  ]
}

/** `var faFolderWireless = { prefix: 'fak', iconName: …, icon: [w, h, [], 'e000', 'M…'] }` in the kit's custom module */
function fromKit(text, name) {
  const match = new RegExp(
    `var ${name} = \\{\\s*prefix: '(\\w+)',\\s*iconName: '([\\w-]+)',\\s*icon: \\[\\s*(\\d+),\\s*(\\d+),\\s*\\[[^\\]]*\\],\\s*'(\\w*)',\\s*'([^']+)'`,
  ).exec(text)
  return match && [match[1], match[2], [Number(match[3]), Number(match[4]), [], match[5], match[6]]]
}

async function main() {
  const auth = token()
  if (!auth) {
    if (required) throw new Error('Font Awesome: no Pro token (--required)')
    // Icons generated earlier stay: an install without the token must not take them away
    console.log(
      existsSync(OUT)
        ? 'Font Awesome: no Pro token, the Pro icons generated before stay'
        : 'Font Awesome: no Pro token, the app uses the Font Awesome Free icons',
    )
    return
  }
  const names = [...readFileSync(path.join(ICONS, 'free.ts'), 'utf8').matchAll(/\b(?:as )?(fa[A-Z]\w*),?$/gm)]
    .map(m => m[1])
    .filter((name, i, all) => all.indexOf(name) == i)
  const [pro, kit] = await Promise.all([fetchPackage(PRO, auth), fetchPackage(KIT, auth)])
  const custom = kit.get('icons/modules/kit/custom.js')?.toString('utf8') ?? ''
  const lines = []
  for (const name of names) {
    const module = pro.get(`${name}.js`)
    const icon = module ? fromIconModule(module.toString('utf8')) : fromKit(custom, name)
    if (!icon || !icon[2][4]) throw new Error(`${name}: not in ${PRO.name} nor in the kit`)
    const [prefix, iconName, data] = icon
    // A cast: the custom icons of the kit have names Font Awesome does not know
    lines.push(
      `export const ${name} = ${JSON.stringify({ prefix, iconName, icon: data })} as unknown as IconDefinition`,
    )
  }
  // A temporary file renamed over the target: an interrupted run never leaves half a module for the build
  const temp = `${OUT}.${process.pid}.tmp`
  writeFileSync(
    temp,
    [
      `// Generated by scripts/pro-icons.mjs from ${PRO.name}@${PRO.version} and the On Page kit.`,
      '// Font Awesome Pro, licensed to On Page: never commit this file.',
      "import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'",
      '',
      ...lines,
      '',
    ].join('\n'),
  )
  renameSync(temp, OUT)
  console.log(`Font Awesome: ${lines.length} Pro light icons written to ${path.relative(ROOT, OUT)}`)
}

main().catch(error => {
  console.error(`Font Awesome: ${error.message}`)
  // Without --required a failure falls back to the Free icons; a release must not
  process.exit(required ? 1 : 0)
})
