/**
 * Putting a content of data/ in the folder under a name: a hard link, or a
 * copy where links are not supported (FAT/exFAT, some NAS, macOS on SMB).
 */
import { randomBytes } from 'crypto'
import { constants, promises as fs } from 'fs'
import path from 'path'
import { ConflictError, errorCode } from './errors'
import { renameWithRetry, unlinkQuiet } from './fsx'
import { TEMP_PREFIX } from './manifest'

export type PlaceMode = 'link' | 'copy'

/** Learned once per job: after the first refusal every name is copied */
export interface LinkCapability {
  hardlinks?: boolean
}

/** Errors that mean "this file system cannot link", not "this name is busy" */
const NOT_A_LINK_PROBLEM = new Set(['EEXIST', 'ENOENT', 'ENOSPC', 'EDQUOT'])

async function linkOrCopy(
  blob: string,
  dest: string,
  capability: LinkCapability,
): Promise<PlaceMode> {
  if (capability.hardlinks !== false) {
    try {
      await fs.link(blob, dest)
      capability.hardlinks = true
      return 'link'
    } catch (error) {
      const code = errorCode(error) ?? ''
      if (NOT_A_LINK_PROBLEM.has(code)) throw error
      capability.hardlinks = false
    }
  }
  // EXCL: never overwrite; FICLONE: copy-on-write where the file system can
  await fs.copyFile(
    blob,
    dest,
    constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
  )
  return 'copy'
}

export interface PlaceOptions {
  folder: string
  data_dir: string
  name: string
  token: string
  /** A name of ours (same key) to replace atomically */
  replace?: string
  capability: LinkCapability
}

/**
 * New names are created exclusively: if something appeared there since the
 * plan, it is a conflict and stays untouched. Replacements go through a
 * temporary name and a rename, so the old file is never missing.
 */
export async function placeName(options: PlaceOptions): Promise<PlaceMode> {
  const { folder, data_dir, name, token, replace, capability } = options
  if (!name || path.basename(name) != name || name == '.' || name == '..') {
    throw new Error(`Unsafe name: ${name}`)
  }
  const blob = path.join(data_dir, token)
  const target = path.join(folder, name)
  if (!replace) {
    try {
      return await linkOrCopy(blob, target, capability)
    } catch (error) {
      if (errorCode(error) == 'EEXIST') throw new ConflictError(name)
      throw error
    }
  }
  const temp = path.join(
    folder,
    `${TEMP_PREFIX}${randomBytes(6).toString('hex')}`,
  )
  try {
    const mode = await linkOrCopy(blob, temp, capability)
    if (replace != name) {
      // Different case: free the old name first (same file on case-insensitive folders)
      await unlinkQuiet(path.join(folder, replace))
    }
    await renameWithRetry(temp, target)
    return mode
  } catch (error) {
    await unlinkQuiet(temp).catch(() => undefined)
    throw error
  }
}

/** Only the case of a name changes: same file, new name */
export async function renameName(
  folder: string,
  from: string,
  to: string,
): Promise<void> {
  if (path.basename(from) != from || path.basename(to) != to)
    throw new Error('Unsafe name')
  await renameWithRetry(path.join(folder, from), path.join(folder, to))
}
