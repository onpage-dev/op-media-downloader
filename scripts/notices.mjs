/**
 * THIRD_PARTY_NOTICES.txt: the licences of everything the app ships, opened
 * from Settings › Updates and packaged next to the app (extraResources). It
 * covers the runtime dependencies and their trees, the libraries bundled into
 * the app (BUNDLED, keep it in step with what the renderer, main and the engine
 * import) and the fonts. Electron's own licences come with Electron.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'THIRD_PARTY_NOTICES.txt')
/** Bundled by electron-vite, so not in `dependencies` */
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
const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i

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

const sections = [...seen.entries()]
  .map(([dir, meta]) => {
    const file = readdirSync(dir).find(name => LICENSE_FILE.test(name))
    const text = file
      ? readFileSync(path.join(dir, file), 'utf8').trim()
      : `License: ${meta.license ?? 'see the package'}`
    return { title: `${meta.name} ${meta.version} (${meta.license ?? 'unknown'})`, text }
  })
  .sort((a, b) => a.title.localeCompare(b.title))

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
