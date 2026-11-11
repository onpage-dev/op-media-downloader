/**
 * THIRD_PARTY_NOTICES.txt: the licences of everything the app ships, opened
 * from Settings › Updates and packaged next to the app (a resource of the
 * Tauri bundle). It covers the JavaScript the page bundles (`dependencies`
 * and BUNDLED, keep it in step with what the renderer imports) with their
 * trees, the Rust crates compiled into the app (from `cargo metadata`, skipped
 * with `--no-rust` or without cargo) and the fonts.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'THIRD_PARTY_NOTICES.txt')
/** Bundled by Vite, so not in `dependencies` */
const BUNDLED = [
  'vue',
  'vue-i18n',
  '@fortawesome/fontawesome-svg-core',
  '@fortawesome/vue-fontawesome',
  '@fortawesome/free-regular-svg-icons',
  '@fortawesome/free-solid-svg-icons',
  'flag-icons',
  'tailwindcss',
]
const LICENSE_FILE = /^(licen[cs]e|copying)([-._](md|txt|markdown|mit|apache|apache-2\.0|bsd|zlib|unicode))*$/i
/** The app's own crates: their licence is the app's */
const OWN_CRATES = new Set(['op-media-downloader', 'op-media-service'])

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/** The folder of `name` as Node would resolve it from `from` */
function locate(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name)
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
    if (path.dirname(dir) == dir) return undefined
  }
}

const seen = new Map()
function walk(name, from) {
  const dir = locate(name, from)
  if (!dir || seen.has(dir)) return
  const meta = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  seen.set(dir, meta)
  for (const dependency of Object.keys(meta.dependencies ?? {})) walk(dependency, dir)
}
for (const name of [...Object.keys(pkg.dependencies ?? {}), ...BUNDLED]) walk(name, ROOT)

/** Every licence file of a package folder, joined */
function licenceText(dir, license) {
  const files = readdirSync(dir)
    .filter(name => LICENSE_FILE.test(name))
    .sort()
  return files.length
    ? files.map(file => readFileSync(path.join(dir, file), 'utf8').trim()).join('\n\n')
    : `License: ${license ?? 'see the package'}`
}

const sections = [...seen.entries()].map(([dir, meta]) => ({
  title: `${meta.name} ${meta.version} (${meta.license ?? 'unknown'})`,
  text: licenceText(dir, meta.license),
}))

/** The crates the app links, for the platform it is built on: normal dependencies only, no build or dev ones */
function rustCrates() {
  let metadata
  try {
    const output = execFileSync('cargo', ['metadata', '--format-version', '1', '--locked'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    metadata = JSON.parse(output)
  } catch {
    console.warn('Third-party notices: cargo metadata failed, the Rust crates are not listed')
    return []
  }
  const packages = new Map(metadata.packages.map(p => [p.id, p]))
  const nodes = new Map(metadata.resolve.nodes.map(n => [n.id, n]))
  const root = metadata.packages.find(p => p.name == 'op-media-downloader')
  const linked = new Set()
  const visit = id => {
    if (linked.has(id)) return
    linked.add(id)
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some(kind => kind.kind === null)) visit(dep.pkg)
    }
  }
  if (root) visit(root.id)
  return [...linked]
    .map(id => packages.get(id))
    .filter(p => p && !OWN_CRATES.has(p.name))
    .map(p => ({
      title: `${p.name} ${p.version} (${p.license ?? 'unknown'}) [crate]`,
      text: licenceText(path.dirname(p.manifest_path), p.license),
    }))
}

if (!process.argv.includes('--no-rust')) sections.push(...rustCrates())
sections.sort((a, b) => a.title.localeCompare(b.title))

const fonts = readFileSync(path.join(ROOT, 'src/renderer/assets/fonts/OFL.txt'), 'utf8').trim()
const header = `On Page Media Downloader ${pkg.version} includes the following third-party software.
Font Awesome icons: Font Awesome Free by Fonticons, Inc. (icons CC BY 4.0, code MIT), or
Font Awesome Pro licensed to On Page in the builds made by On Page.`

writeFileSync(
  OUT,
  [
    header,
    `${'='.repeat(78)}\nFonts: Manrope, Rethink Sans\n\n${fonts}`,
    ...sections.map(s => `${'='.repeat(78)}\n${s.title}\n\n${s.text}`),
  ].join('\n\n') + '\n',
)
console.log(`Third-party notices: ${sections.length} packages and the fonts in ${path.relative(ROOT, OUT)}`)
