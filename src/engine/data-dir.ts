/**
 * Who owns `<folder>/data`. The app removes contents from data/ freely, so it
 * must be sure the folder is its own: a `data` folder the user already had in
 * the chosen folder is never used, emptied or deleted.
 */
import { promises as fs } from 'fs'
import path from 'path'
import { LINK_JSON_FILE, LOCK_FILE, MANIFEST_FILE, TEMP_PREFIX } from './manifest'

export type DataDirOwner = 'missing' | 'ours' | 'foreign'

/** An On Page storage token (hex, optionally with an extension) or one of its temporary files */
const TOKEN_LIKE = /^[0-9a-f]{24,64}(\.[A-Za-z0-9]{1,10})?(\.download|\.tmp)?$/i
const SERVICE_FILES = new Set([MANIFEST_FILE, LINK_JSON_FILE, LOCK_FILE])

export function isOwnDataEntry(name: string): boolean {
  return (
    SERVICE_FILES.has(name) ||
    name.startsWith(TEMP_PREFIX) ||
    name.startsWith(`${MANIFEST_FILE}.`) ||
    TOKEN_LIKE.test(name)
  )
}

/**
 * `ours` when data/ holds the manifest or the 1.x link.json, or only tokens
 * and service files (a 1.x first download interrupted before link.json was
 * written); `foreign` when it holds anything else.
 */
export async function dataDirOwner(data_dir: string): Promise<DataDirOwner> {
  let entries: string[]
  try {
    entries = await fs.readdir(data_dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code == 'ENOENT') return 'missing'
    throw error
  }
  if (entries.includes(MANIFEST_FILE) || entries.includes(LINK_JSON_FILE)) return 'ours'
  return entries.every(isOwnDataEntry) ? 'ours' : 'foreign'
}

/** Removes what the app put in data/ and data/ itself when nothing else is left */
export async function removeOwnDataEntries(data_dir: string): Promise<{ removed: number; kept: number }> {
  let entries: string[]
  try {
    entries = await fs.readdir(data_dir)
  } catch {
    return { removed: 0, kept: 0 }
  }
  let removed = 0
  let kept = 0
  for (const name of entries) {
    if (!isOwnDataEntry(name)) {
      kept++
      continue
    }
    try {
      await fs.rm(path.join(data_dir, name), { force: true })
      removed++
    } catch {
      kept++
    }
  }
  if (!kept) await fs.rmdir(data_dir).catch(() => undefined)
  return { removed, kept }
}
