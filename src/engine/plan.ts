/**
 * The plan: what a folder needs to match On Page. A pure function of the
 * remote names, the manifest and one scan of the folder, so it can be tested
 * on hundreds of thousands of files and never touches a disk.
 *
 * Safety rules (docs/ARCHITECTURE.md):
 * 1. only names in the manifest and contents in data/ are ever removed;
 * 2. a name on disk that the manifest does not know is never overwritten:
 *    it is adopted only when it is the same file as data/<token> or has the
 *    expected size, otherwise it is a conflict;
 * 3. removals above the threshold wait for a confirmation;
 * 4. no removal after an incomplete listing.
 */
import { PlanSummary } from '../shared/models'
import { ManifestEntry } from './manifest'
import { DesiredFile, nameKey } from './names'
import { FolderScan } from './scan'

export const CLEANUP_MIN_NAMES = 50
export const CLEANUP_MIN_RATIO = 0.25

export interface ManifestView {
  readonly size: number
  entries(): [string, ManifestEntry][]
  byKey(key: string): [string, ManifestEntry] | undefined
}

/** Facts about a name on disk that the manifest does not know (rule 2) */
export interface AdoptionStat {
  name_ino?: bigint
  name_size?: number
  blob_ino?: bigint
}

export interface NameTarget {
  /** Final name in the folder */
  name: string
  remote_name: string
  size?: number
  /** A name of ours (same key) to replace: content changed or case changed */
  replace?: string
}

export interface DownloadTask {
  token: string
  size?: number
  names: NameTarget[]
}

export interface LinkTask extends NameTarget {
  token: string
}

/** Same content, only the case of the name changes */
export interface RenameTask {
  from: string
  to: string
  token: string
  entry: ManifestEntry
}

export interface Adoption {
  name: string
  token: string
  size?: number
  mode: 'link' | 'adopted'
  remote_name: string
}

export interface Conflict {
  name: string
  token: string
  remote_name: string
  size?: number
}

export interface Plan {
  downloads: DownloadTask[]
  links: LinkTask[]
  renames: RenameTask[]
  adoptions: Adoption[]
  remove_names: string[]
  remove_tokens: string[]
  /** Manifest entries whose file is gone and is not wanted: forget them */
  drop_entries: string[]
  conflicts: Conflict[]
  up_to_date: number
  /** Removals held back by the threshold */
  withheld_removals: number
  summary: Omit<PlanSummary, 'created_at'>
}

export interface PlanInput {
  desired: DesiredFile[]
  manifest: ManifestView
  scan: FolderScan
  keep_old_files: boolean
  listing_complete: boolean
  listing: 'full' | 'incremental'
  cleanup_confirmed?: boolean
  duplicates?: number
  /** For the keys returned by adoptionCandidates */
  adoption?: Map<string, AdoptionStat>
}

/** Desired names on disk that the manifest does not know: they need a stat */
export function adoptionCandidates(
  desired: DesiredFile[],
  manifest: ManifestView,
  scan: FolderScan,
): { key: string; name: string; token: string }[] {
  const out: { key: string; name: string; token: string }[] = []
  for (const file of desired) {
    if (manifest.byKey(file.key)) continue
    const entry = scan.entries.get(file.key)
    if (entry?.type == 'file')
      out.push({ key: file.key, name: entry.name, token: file.token })
  }
  return out
}

export function buildPlan(input: PlanInput): Plan {
  const { desired, manifest, scan } = input
  const downloads = new Map<string, DownloadTask>()
  const links: LinkTask[] = []
  const renames: RenameTask[] = []
  const adoptions: Adoption[] = []
  const conflicts: Conflict[] = []
  let up_to_date = 0

  const need = (token: string, target: NameTarget): void => {
    if (scan.data_tokens.has(token)) {
      links.push({ ...target, token })
      return
    }
    let task = downloads.get(token)
    if (!task) {
      task = { token, size: target.size, names: [] }
      downloads.set(token, task)
    }
    task.names.push(target)
  }

  const desired_keys = new Set<string>()
  for (const file of desired) {
    desired_keys.add(file.key)
    const on_disk = scan.entries.get(file.key)
    const owned = manifest.byKey(file.key)
    const target: NameTarget = {
      name: file.local_name,
      remote_name: file.remote_name,
      size: file.size,
    }

    if (on_disk && on_disk.type != 'file') {
      // A folder (or something else) took the name: never touched
      conflicts.push({
        name: file.local_name,
        token: file.token,
        remote_name: file.remote_name,
        size: file.size,
      })
      continue
    }

    if (owned) {
      const [owned_name, entry] = owned
      if (!on_disk) {
        need(
          file.token,
          owned_name != file.local_name
            ? { ...target, replace: owned_name }
            : target,
        )
      } else if (entry.token == file.token) {
        if (on_disk.name == file.local_name) up_to_date++
        else
          renames.push({
            from: on_disk.name,
            to: file.local_name,
            token: file.token,
            entry,
          })
      } else {
        need(file.token, { ...target, replace: on_disk.name })
      }
      continue
    }

    if (!on_disk) {
      need(file.token, target)
      continue
    }

    // Rule 2: a file the manifest does not know
    const stat = input.adoption?.get(file.key)
    const same_file =
      stat?.name_ino !== undefined &&
      stat.blob_ino !== undefined &&
      stat.name_ino != 0n &&
      stat.name_ino == stat.blob_ino &&
      scan.data_tokens.has(file.token)
    const same_size =
      stat?.name_size !== undefined &&
      file.size !== undefined &&
      stat.name_size == file.size
    if (same_file || same_size) {
      adoptions.push({
        name: on_disk.name,
        token: file.token,
        size: file.size,
        mode: same_file ? 'link' : 'adopted',
        remote_name: file.remote_name,
      })
      if (on_disk.name == file.local_name) up_to_date++
      else {
        renames.push({
          from: on_disk.name,
          to: file.local_name,
          token: file.token,
          entry: {
            token: file.token,
            size: file.size,
            mode: same_file ? 'link' : 'adopted',
            remote_name: file.remote_name,
          },
        })
      }
      continue
    }
    conflicts.push({
      name: on_disk.name,
      token: file.token,
      remote_name: file.remote_name,
      size: file.size,
    })
  }

  // Removals: rules 1, 3, 4
  let remove_names: string[] = []
  const drop_entries: string[] = []
  for (const [name] of manifest.entries()) {
    const key = nameKey(name)
    if (desired_keys.has(key)) continue
    const on_disk = scan.entries.get(key)
    if (!on_disk) {
      drop_entries.push(name)
      continue
    }
    if (input.keep_old_files || !input.listing_complete) continue
    // The name on disk must be exactly ours and a plain file
    if (on_disk.name == name && on_disk.type == 'file') remove_names.push(name)
    else drop_entries.push(name)
  }

  let withheld_removals = 0
  if (
    !input.cleanup_confirmed &&
    remove_names.length > CLEANUP_MIN_NAMES &&
    remove_names.length > CLEANUP_MIN_RATIO * manifest.size
  ) {
    withheld_removals = remove_names.length
    remove_names = []
  }

  // Contents nobody needs any more
  const remove_tokens: string[] = []
  if (input.listing_complete) {
    const referenced = new Set<string>()
    for (const file of desired) referenced.add(file.token)
    const leaving = new Set([...remove_names, ...drop_entries])
    for (const [name, entry] of manifest.entries()) {
      // Wanted names get the wanted token: their old content is no longer needed
      if (!leaving.has(name) && !desired_keys.has(nameKey(name)))
        referenced.add(entry.token)
    }
    for (const token of scan.data_tokens)
      if (!referenced.has(token)) remove_tokens.push(token)
  }

  const download_list = Array.from(downloads.values())
  const summary: Omit<PlanSummary, 'created_at'> = {
    remote_names: desired.length,
    remote_bytes: desired.reduce((sum, f) => sum + (f.size ?? 0), 0),
    to_download: download_list.length,
    to_download_names: download_list.reduce(
      (sum, t) => sum + t.names.length,
      0,
    ),
    to_download_bytes: download_list.reduce((sum, t) => sum + (t.size ?? 0), 0),
    to_link: links.length + renames.length,
    to_remove: remove_names.length || withheld_removals,
    up_to_date,
    duplicates: input.duplicates ?? 0,
    conflicts: conflicts.length,
    cleanup_needs_confirmation: withheld_removals > 0,
    listing: input.listing,
  }

  return {
    downloads: download_list,
    links,
    renames,
    adoptions,
    remove_names,
    remove_tokens,
    drop_entries,
    conflicts,
    up_to_date,
    withheld_removals,
    summary,
  }
}

/** True when executing the plan would change nothing on disk */
export function planIsEmpty(plan: Plan): boolean {
  return (
    !plan.downloads.length &&
    !plan.links.length &&
    !plan.renames.length &&
    !plan.remove_names.length &&
    !plan.remove_tokens.length
  )
}
