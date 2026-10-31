/**
 * Putting a content of data/ in the folder under a name: a hard link, or a
 * copy where links are not supported (FAT/exFAT, some NAS, macOS on SMB).
 */
import { randomBytes } from 'crypto'
import { constants, promises as fs } from 'fs'
import path from 'path'
import { ConflictError, errorCode, InUseError } from './errors'
import { flushFile, isTransientLock, pathExists, renameWithRetry, unlinkQuiet, withLockRetry } from './fsx'
import { TEMP_PREFIX } from './manifest'

export type PlaceMode = 'link' | 'copy'

/**
 * Decided once per job by a probe (probeHardLinks): every name is a link, or
 * every name a copy; undefined when the probe could not run
 */
export interface LinkCapability {
  hardlinks?: boolean
}

/**
 * What a file system that cannot link answers: ENOTSUP (SMB without links),
 * EISDIR (Windows on FAT/exFAT: ERROR_INVALID_FUNCTION), EPERM (Linux vfat).
 * On the probe's own new file EPERM and EACCES can only mean that too.
 */
const LINKS_UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EISDIR', 'EINVAL', 'EPERM', 'EACCES'])

/**
 * Can the folder hold hard links? A temporary file in data/ is linked, then
 * both go (a leftover is cleared by the next run). A name that later fails
 * to link fails alone: one bad name never turns a whole job into copies.
 * Undefined when the probe file cannot even be written: the work tells.
 */
export async function probeHardLinks(data_dir: string): Promise<boolean | undefined> {
  const base = path.join(data_dir, `${TEMP_PREFIX}probe-${randomBytes(4).toString('hex')}`)
  const file = `${base}.tmp`
  const link = `${base}.lnk`
  try {
    await fs.writeFile(file, '')
  } catch {
    return undefined
  }
  try {
    await fs.link(file, link)
    return true
  } catch (error) {
    return LINKS_UNSUPPORTED.has(errorCode(error) ?? '') ? false : undefined
  } finally {
    await unlinkQuiet(link).catch(() => undefined)
    await unlinkQuiet(file).catch(() => undefined)
  }
}

/**
 * A copy under a temporary name, flushed to the disk, then given the name: a
 * copy cut halfway (an unplugged disk, a crash) never sits under the name.
 */
async function copyTo(blob: string, dest: string, exclusive: boolean): Promise<void> {
  const temp = path.join(path.dirname(dest), `${TEMP_PREFIX}${randomBytes(6).toString('hex')}`)
  try {
    await fs.copyFile(blob, temp, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    await flushFile(temp)
    // The name was free when the plan was made: a file that appeared since is someone else's
    if (exclusive && (await pathExists(dest)))
      throw Object.assign(new Error(`${dest} already exists`), { code: 'EEXIST' })
    await renameWithRetry(temp, dest)
  } catch (error) {
    await unlinkQuiet(temp).catch(() => undefined)
    throw error
  }
}

async function linkOrCopy(blob: string, dest: string, capability: LinkCapability, exclusive: boolean): Promise<PlaceMode> {
  if (capability.hardlinks !== false) {
    try {
      await withLockRetry(() => fs.link(blob, dest), 4)
      return 'link'
    } catch (error) {
      const code = errorCode(error) ?? ''
      // NTFS takes 1023 names per file: this content gets a copy, the others
      // keep their links. Without a probe, a refusal gets a copy for this name only
      const copy = code == 'EMLINK' || (capability.hardlinks === undefined && LINKS_UNSUPPORTED.has(code))
      if (!copy) throw error
    }
  }
  await copyTo(blob, dest, exclusive)
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

/** A rename or removal refused by a lock that did not go away: on Windows, the file is open somewhere */
function inUse(error: unknown, name: string): unknown {
  return process.platform == 'win32' && isTransientLock(error) ? new InUseError(name, error) : error
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
      return await linkOrCopy(blob, target, capability, true)
    } catch (error) {
      if (errorCode(error) == 'EEXIST') throw new ConflictError(name)
      throw error
    }
  }
  const temp = path.join(folder, `${TEMP_PREFIX}${randomBytes(6).toString('hex')}`)
  try {
    const mode = await linkOrCopy(blob, temp, capability, false)
    try {
      if (replace != name) {
        // Different case: free the old name first (same file on case-insensitive folders)
        await withLockRetry(() => unlinkQuiet(path.join(folder, replace)), 4)
      }
      await renameWithRetry(temp, target)
    } catch (error) {
      throw inUse(error, replace)
    }
    return mode
  } catch (error) {
    await unlinkQuiet(temp).catch(() => undefined)
    throw error
  }
}

/** Only the case of a name changes: same file, new name */
export async function renameName(folder: string, from: string, to: string): Promise<void> {
  if (path.basename(from) != from || path.basename(to) != to) throw new Error('Unsafe name')
  try {
    await renameWithRetry(path.join(folder, from), path.join(folder, to))
  } catch (error) {
    throw inUse(error, from)
  }
}

/** Removes a name of ours; a file open in another program (Windows) is an InUseError */
export async function removeName(folder: string, name: string): Promise<boolean> {
  if (path.basename(name) != name) throw new Error('Unsafe name')
  try {
    return await withLockRetry(() => unlinkQuiet(path.join(folder, name)), 4)
  } catch (error) {
    throw inUse(error, name)
  }
}
