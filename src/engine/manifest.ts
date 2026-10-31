/**
 * data/manifest.json: the registry of what the app created in a folder.
 * Only names listed here (and contents in data/) can ever be removed.
 */
import { promises as fs } from 'fs'
import path from 'path'
import { isNotFound, JobError } from './errors'
import { atomicWrite, withLockRetry } from './fsx'
import { isSafeToken, nameKey, sanitizeName } from './names'

export const DATA_DIR = 'data'
export const MANIFEST_FILE = 'manifest.json'
export const LINK_JSON_FILE = 'link.json'
export const LOCK_FILE = '.lock'
/** Prefix of the app's temporary names in the project folder */
export const TEMP_PREFIX = '.opmd-'

/**
 * How the name was made: a hard link to data/<token>, a copy of it, a file
 * found in place and recognised as ours, or imported from 1.x (unknown).
 */
export type ManifestMode = 'link' | 'copy' | 'adopted' | 'unknown'

export interface ManifestEntry {
  token: string
  size?: number
  mode: ManifestMode
  remote_name?: string
}

/** The registry's format; a newer one is another app's to read */
const VERSION = 2

interface ManifestJson {
  version: typeof VERSION
  project_id: string
  updated_at: string
  files: Record<string, ManifestEntry>
}

export type ManifestSource = 'manifest' | 'link.json' | 'empty'

export interface ManifestLoad {
  manifest: Manifest
  source: ManifestSource
  /** manifest.json existed but could not be read */
  recovered: boolean
}

const MIN_CHECKPOINT_MS = 5_000
const MAX_CHECKPOINT_MS = 30_000
const CHECKPOINT_CHANGES = 500

export class Manifest {
  private files = new Map<string, ManifestEntry>()
  private keys = new Map<string, string>()
  private changes = 0
  private last_flush = Date.now()
  private last_flush_ms = 0
  private flushing?: Promise<void>

  constructor(
    public readonly data_dir: string,
    public readonly project_id: string,
  ) {}

  static file(data_dir: string): string {
    return path.join(data_dir, MANIFEST_FILE)
  }

  /**
   * A manifest written by a newer version of the app is refused, untouched:
   * read as broken, it would be rebuilt and overwritten with our format
   */
  static async load(data_dir: string, project_id: string): Promise<ManifestLoad> {
    const manifest = new Manifest(data_dir, project_id)
    let recovered = false
    const text = await readText(Manifest.file(data_dir))
    if (text !== undefined) {
      const json = parse<Omit<ManifestJson, 'version'> & { version?: unknown }>(text)
      if (typeof json?.version == 'number' && json.version > VERSION) {
        throw new JobError(
          'folder_protected',
          'The folder was synced by a newer version of the app',
          `The folder was synced by a newer version of the app (data/${MANIFEST_FILE} version ${json.version})`,
        )
      }
      if (json && json.version == VERSION && json.files && typeof json.files == 'object') {
        for (const [name, entry] of Object.entries(json.files)) {
          if (validName(name) && entry && isSafeToken(entry.token)) {
            manifest.put(name, {
              token: entry.token,
              size: typeof entry.size == 'number' ? entry.size : undefined,
              mode: entry.mode ?? 'unknown',
              remote_name: entry.remote_name,
            })
          }
        }
        return { manifest, source: 'manifest', recovered }
      }
      recovered = true
    }
    // 1.x: { "<name>": "<token>" }
    const link_json = await readText(path.join(data_dir, LINK_JSON_FILE))
    const links = link_json === undefined ? undefined : parse<Record<string, unknown>>(link_json)
    if (links && typeof links == 'object') {
      for (const [name, token] of Object.entries(links)) {
        if (validName(name) && typeof token == 'string' && isSafeToken(token)) {
          manifest.put(name, { token, mode: 'unknown', remote_name: name })
        }
      }
      manifest.changes = manifest.files.size
      return { manifest, source: 'link.json', recovered }
    }
    return { manifest, source: 'empty', recovered }
  }

  get size(): number {
    return this.files.size
  }

  entries(): [string, ManifestEntry][] {
    return Array.from(this.files.entries())
  }

  get(name: string): ManifestEntry | undefined {
    return this.files.get(name)
  }

  /** The entry whose name is the same ignoring case */
  byKey(key: string): [string, ManifestEntry] | undefined {
    const name = this.keys.get(key)
    return name === undefined ? undefined : [name, this.files.get(name)!]
  }

  /** Adds or replaces; an entry differing only in case is replaced */
  set(name: string, entry: ManifestEntry): void {
    const key = nameKey(name)
    const previous = this.keys.get(key)
    if (previous !== undefined && previous != name) this.files.delete(previous)
    this.files.set(name, entry)
    this.keys.set(key, name)
    this.changes++
  }

  delete(name: string): void {
    if (!this.files.delete(name)) return
    const key = nameKey(name)
    if (this.keys.get(key) == name) this.keys.delete(key)
    this.changes++
  }

  private put(name: string, entry: ManifestEntry): void {
    this.files.set(name, entry)
    const key = nameKey(name)
    if (!this.keys.has(key)) this.keys.set(key, name)
  }

  toJson(): ManifestJson {
    return {
      version: VERSION,
      project_id: this.project_id,
      updated_at: new Date().toISOString(),
      files: Object.fromEntries(this.files),
    }
  }

  /** Writes now (atomically) */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing
    if (!this.changes) return
    const started = Date.now()
    const changes = this.changes
    this.flushing = atomicWrite(Manifest.file(this.data_dir), JSON.stringify(this.toJson()))
    try {
      await this.flushing
      this.changes -= changes
      this.last_flush = Date.now()
      this.last_flush_ms = this.last_flush - started
    } finally {
      this.flushing = undefined
    }
  }

  /**
   * Writes when enough happened: 500 changes and 5 s, or 30 s with any
   * change; never more often than ten times the last write took (a big
   * manifest on a slow share).
   */
  async checkpoint(): Promise<void> {
    if (!this.changes || this.flushing) return
    const elapsed = Date.now() - this.last_flush
    const floor = Math.max(MIN_CHECKPOINT_MS, this.last_flush_ms * 10)
    if (elapsed < floor) return
    if (this.changes >= CHECKPOINT_CHANGES || elapsed >= Math.max(MAX_CHECKPOINT_MS, floor)) {
      await this.flush()
    }
  }
}

function validName(name: string): boolean {
  return typeof name == 'string' && name.length > 0 && sanitizeName(name) == name.normalize('NFC')
}

/**
 * A file that is not there is undefined; one that cannot be read (a share
 * that dropped, an antivirus holding it) is an error: starting from an empty
 * registry would forget which names are ours.
 */
async function readText(file: string): Promise<string | undefined> {
  try {
    return await withLockRetry(() => fs.readFile(file, 'utf8'), 4)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

function parse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}
