/**
 * From the remote index to the names the folder must contain: safe names,
 * case-insensitive uniqueness with a deterministic winner, duplicate groups.
 */
import { RemoteIndex } from './remote-index'

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i
// eslint-disable-next-line no-control-regex -- control characters are exactly what must go
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f\u007f]/g
const MAX_NAME_BYTES = 200
const MAX_EXT_CHARS = 16

/**
 * A name that is valid on Windows, macOS and Linux and cannot leave the
 * folder: no separators or `..`, no forbidden or control characters, no
 * reserved device names, no trailing dots or spaces, at most 200 UTF-8 bytes
 * keeping the extension. Network shares are often Windows-backed, so the
 * Windows rules apply everywhere.
 */
export function sanitizeName(raw: string): string {
  let name = String(raw ?? '')
    .normalize('NFC')
    .replace(FORBIDDEN, '_')
  name = name.replace(/[. ]+$/, '')
  if (!name || name == '.' || name == '..') name = '_'
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  if (RESERVED.test(stem.split('.')[0].trim())) name = '_' + name
  /** The folder of the app's own files */
  if (name.toLowerCase() == 'data') name = '_' + name
  return truncate(name)
}

function truncate(name: string): string {
  if (Buffer.byteLength(name) <= MAX_NAME_BYTES) return name
  const dot = name.lastIndexOf('.')
  const has_ext = dot > 0 && name.length - dot - 1 <= MAX_EXT_CHARS
  const ext = has_ext ? name.slice(dot) : ''
  let stem = has_ext ? name.slice(0, dot) : name
  while (stem && Buffer.byteLength(stem + ext) > MAX_NAME_BYTES) {
    stem = Array.from(stem).slice(0, -1).join('')
  }
  return (stem.replace(/[. ]+$/, '') || '_') + ext
}

/** Case-insensitive identity of a name (Windows and macOS folders ignore case) */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/** Tokens become file names in data/: they must be plain */
export function isSafeToken(token: string): boolean {
  return (
    typeof token == 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(token) &&
    !token.includes('..') &&
    !token.endsWith('.download') &&
    !token.startsWith('.')
  )
}

export interface FileUse {
  resource_id: number
  thing_id: number
  field_id: number
  lang: string | null
}

export interface DesiredFile {
  key: string
  /** Name in the folder (safe) */
  local_name: string
  /** Name on On Page */
  remote_name: string
  token: string
  size?: number
  use: FileUse
}

export interface DuplicateVariantRaw {
  token: string
  remote_name: string
  size?: number
  width?: number
  height?: number
  chosen: boolean
  uses: FileUse[]
}

export interface DuplicateRaw {
  key: string
  /** The name of the chosen variant */
  name: string
  variants: DuplicateVariantRaw[]
}

export interface InvalidFile {
  remote_name: string
  token: string
  use: FileUse
}

export interface ResolvedNames {
  desired: DesiredFile[]
  duplicates: DuplicateRaw[]
  /** Files whose token cannot be stored safely */
  invalid: InvalidFile[]
  /** Names that had to be changed to be valid */
  renamed: number
}

/**
 * Walks the index in a fixed order (resources and fields as in the schema,
 * things by id, langs as in the schema, files as in the value) so the same
 * remote content always gives the same winner for a name.
 */
export function resolveNames(index: RemoteIndex): ResolvedNames {
  const by_key = new Map<string, DesiredFile>()
  const groups = new Map<string, DuplicateRaw>()
  const desired: DesiredFile[] = []
  const invalid: InvalidFile[] = []
  let renamed = 0

  for (const resource of index.resources) {
    const thing_ids = Array.from(resource.things.keys()).sort((a, b) => a - b)
    for (const thing_id of thing_ids) {
      for (const [
        field_id,
        lang,
        remote_name,
        token,
        size,
        width,
        height,
      ] of resource.things.get(thing_id)!) {
        const use: FileUse = {
          resource_id: resource.id,
          thing_id,
          field_id,
          lang,
        }
        if (!isSafeToken(token)) {
          invalid.push({ remote_name, token, use })
          continue
        }
        const local_name = sanitizeName(remote_name)
        const key = nameKey(local_name)
        const winner = by_key.get(key)
        if (!winner) {
          if (local_name != remote_name.normalize('NFC')) renamed++
          const file: DesiredFile = {
            key,
            local_name,
            remote_name,
            token,
            size: size ?? undefined,
            use,
          }
          by_key.set(key, file)
          desired.push(file)
          continue
        }
        if (winner.token == token) continue
        let group = groups.get(key)
        if (!group) {
          group = {
            key,
            name: winner.local_name,
            variants: [
              {
                token: winner.token,
                remote_name: winner.remote_name,
                size: winner.size,
                chosen: true,
                uses: [winner.use],
              },
            ],
          }
          groups.set(key, group)
        }
        let variant = group.variants.find(v => v.token == token)
        if (!variant) {
          variant = {
            token,
            remote_name,
            size: size ?? undefined,
            width: width ?? undefined,
            height: height ?? undefined,
            chosen: false,
            uses: [],
          }
          group.variants.push(variant)
        }
        variant.uses.push(use)
      }
    }
  }

  // Every use of the winning token, for the duplicates view
  if (groups.size) {
    for (const resource of index.resources) {
      for (const [thing_id, tuples] of resource.things) {
        for (const [
          field_id,
          lang,
          remote_name,
          token,
          ,
          width,
          height,
        ] of tuples) {
          const group = groups.get(nameKey(sanitizeName(remote_name)))
          if (!group) continue
          const chosen = group.variants[0]
          if (token != chosen.token) continue
          if (width !== null) chosen.width = width
          if (height !== null) chosen.height = height
          const use = { resource_id: resource.id, thing_id, field_id, lang }
          if (!chosen.uses.some(u => sameUse(u, use))) chosen.uses.push(use)
        }
      }
    }
  }

  return { desired, duplicates: Array.from(groups.values()), invalid, renamed }
}

function sameUse(a: FileUse, b: FileUse): boolean {
  return (
    a.resource_id == b.resource_id &&
    a.thing_id == b.thing_id &&
    a.field_id == b.field_id &&
    a.lang == b.lang
  )
}
