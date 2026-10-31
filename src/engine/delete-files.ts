/**
 * Deleting a project's files: the names of the manifest and what the app put
 * in data/; the folder itself only when nothing else is left in it. The
 * folder lock is held until data/ is empty and goes last, so no other
 * instance starts on a half-deleted folder; the engine starts no job of the
 * project meanwhile.
 */
import { promises as fs } from 'fs'
import path from 'path'
import { DeleteFilesResult, EngineProject } from '../shared/engine-protocol'
import { dataDirOwner, removeOwnDataEntries } from './data-dir'
import { normalize } from './folder-inspect'
import { pathExists, unlinkQuiet } from './fsx'
import { removeName } from './link'
import { FolderLock } from './lock'
import { DATA_DIR, Manifest } from './manifest'
import { nameKey, sameName } from './names'
import { runQueue } from './queue'
import { scanFolder } from './scan'

export interface DeleteOptions {
  instance_id: string
  lock_stale_ms?: number
  lock_heartbeat_ms?: number
}

/** Removals at a time: a share answers each one slowly */
const LANES = 8

export async function deleteProjectFiles(project: EngineProject, options: DeleteOptions): Promise<DeleteFilesResult> {
  const folder = normalize(project.folder)
  const data_dir = path.join(folder, DATA_DIR)
  const result: DeleteFilesResult = {
    removed_files: 0,
    removed_folder: false,
    kept_entries: 0,
  }
  if (!(await pathExists(folder))) return result
  // A data/ folder the app did not create is left as it is, and so is everything else
  if ((await dataDirOwner(data_dir).catch(() => 'foreign')) == 'ours') {
    const lock = await FolderLock.acquire(data_dir, {
      instance_id: options.instance_id,
      project_id: project.id,
      stale_ms: options.lock_stale_ms,
      heartbeat_ms: options.lock_heartbeat_ms,
    })
    try {
      const { manifest } = await Manifest.load(data_dir, project.id)
      const scan = await scanFolder(folder)
      await runQueue(manifest.entries(), LANES, async ([name]) => {
        // Exactly our name, as the disk gives it back (decomposed on macOS), and a plain file
        const entry = scan.entries.get(nameKey(name))
        if (entry?.type != 'file' || !sameName(entry.name, name)) return
        if (await removeName(folder, entry.name).catch(() => false)) result.removed_files++
      })
      await runQueue(scan.folder_leftovers, LANES, async leftover => {
        await unlinkQuiet(path.join(folder, leftover)).catch(() => undefined)
      })
      await removeOwnDataEntries(data_dir)
    } finally {
      await lock.release()
    }
    await fs.rmdir(data_dir).catch(() => undefined)
  }
  const left = await fs.readdir(folder).catch(() => [] as string[])
  result.kept_entries = left.length
  if (!left.length) {
    await fs.rmdir(folder).then(
      () => (result.removed_folder = true),
      () => undefined,
    )
  }
  return result
}
