/**
 * One asynchronous listing of the project folder and one of data/ per job.
 */
import { promises as fs } from 'fs'
import path from 'path'
import { isNotFound } from './errors'
import { DATA_DIR, LINK_JSON_FILE, LOCK_FILE, MANIFEST_FILE, TEMP_PREFIX } from './manifest'
import { isSafeToken, nameKey } from './names'

export type EntryType = 'file' | 'dir' | 'other'

export interface FolderEntry {
  name: string
  type: EntryType
}

export interface FolderScan {
  /** Entries of the project folder by case-insensitive key, data/ excluded */
  entries: Map<string, FolderEntry>
  /** Tokens present in data/ */
  data_tokens: Set<string>
  /** `<token>.download` and other leftovers of interrupted runs, in data/ */
  data_leftovers: string[]
  /** `.opmd-*` temporary names in the project folder */
  folder_leftovers: string[]
}

const DATA_OWN_FILES = new Set([MANIFEST_FILE, LINK_JSON_FILE, LOCK_FILE])

function entryType(entry: { isFile(): boolean; isDirectory(): boolean }): EntryType {
  return entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other'
}

export async function scanFolder(folder: string): Promise<FolderScan> {
  const scan: FolderScan = {
    entries: new Map(),
    data_tokens: new Set(),
    data_leftovers: [],
    folder_leftovers: [],
  }
  for (const entry of await readdirSafe(folder)) {
    if (nameKey(entry.name) == DATA_DIR) continue
    if (entry.name.startsWith(TEMP_PREFIX)) {
      scan.folder_leftovers.push(entry.name)
      continue
    }
    const key = nameKey(entry.name)
    // Case-sensitive folders can hold two names with one key: keep the first
    if (!scan.entries.has(key)) scan.entries.set(key, { name: entry.name, type: entryType(entry) })
  }
  for (const entry of await readdirSafe(path.join(folder, DATA_DIR))) {
    if (!entry.isFile()) continue
    if (DATA_OWN_FILES.has(entry.name)) continue
    if (entry.name.endsWith('.download') || entry.name.endsWith('.tmp') || entry.name.startsWith(TEMP_PREFIX)) {
      scan.data_leftovers.push(entry.name)
      continue
    }
    if (isSafeToken(entry.name)) scan.data_tokens.add(entry.name)
  }
  return scan
}

async function readdirSafe(dir: string): Promise<import('fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}
