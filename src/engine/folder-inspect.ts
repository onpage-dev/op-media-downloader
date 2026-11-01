/**
 * What kind of folder a project uses, and whether it is safe: reachable,
 * writable, with hard links or not, free space, protected paths, overlaps
 * with other projects, entries the app did not create, a lock by someone else.
 * Inspecting never creates folders and leaves no file behind.
 */
import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { DestinationKind, FolderInfo, FolderProblem, ProjectId } from '../shared/models'
import { dataDirOwner } from './data-dir'
import { errorCode, isNotFound } from './errors'
import { reachable, unlinkQuiet } from './fsx'
import { isStale, readLock } from './lock'
import { DATA_DIR, Manifest } from './manifest'
import { nameKey } from './names'

export interface InspectContext {
  project_id?: ProjectId
  project_folders: { id: ProjectId; folder: string }[]
  instance_id?: string
  platform?: NodeJS.Platform
  /** Injected in tests: drive letter → kind */
  driveKind?: (drive: string) => Promise<DestinationKind>
  /** How long a folder may take to answer before it counts as unreachable */
  reach_timeout_ms?: number
}

export const REACH_TIMEOUT_MS = 5_000

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform == 'linux' ? a == b : a.toLowerCase() == b.toLowerCase()
}

/** Absolute, without a trailing separator (roots keep theirs: `C:\`, `/`) */
export function normalize(p: string): string {
  const resolved = path.resolve(p)
  const root = path.parse(resolved).root
  return resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved
}

/** a is b, or a is inside b */
export function isInside(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const na = normalize(a)
  const nb = normalize(b)
  if (samePath(na, nb, platform)) return true
  const prefix = nb.endsWith(path.sep) ? nb : nb + path.sep
  return platform == 'linux' ? na.startsWith(prefix) : na.toLowerCase().startsWith(prefix.toLowerCase())
}

/** Drive roots (not share roots), the home folder and system folders */
export function isProtectedPath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  const resolved = normalize(p)
  if (resolved == path.parse(resolved).root) {
    // A UNC share root (\\server\share\) is a reasonable dedicated destination
    return !/^\\\\[^\\]+\\[^\\]+\\?$/.test(resolved)
  }
  const home = normalize(os.homedir())
  if (samePath(resolved, home, platform)) return true
  const system =
    platform == 'win32'
      ? [
          process.env.SystemRoot ?? 'C:\\Windows',
          process.env.ProgramFiles ?? 'C:\\Program Files',
          process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
          process.env.ProgramData ?? 'C:\\ProgramData',
          path.dirname(home),
        ]
      : platform == 'darwin'
        ? [
            '/System',
            '/Library',
            '/Applications',
            '/Users',
            '/usr',
            '/bin',
            '/sbin',
            '/etc',
            '/var',
            '/private',
            '/opt',
            '/Volumes',
          ]
        : [
            '/usr',
            '/bin',
            '/sbin',
            '/etc',
            '/var',
            '/proc',
            '/sys',
            '/dev',
            '/boot',
            '/root',
            '/home',
            '/opt',
            '/lib',
            '/media',
            '/mnt',
            '/run',
          ]
  return system.some(dir => {
    const d = normalize(dir)
    // The system folder itself, or anything inside the Windows / Program Files ones
    return (
      samePath(resolved, d, platform) ||
      (platform == 'win32' && d != path.dirname(home) && isInside(resolved, d, platform))
    )
  })
}

const drive_kinds = new Map<string, Promise<DestinationKind>>()

/** Windows drive letter → kind, through CIM (DriveType), cached */
function windowsDriveKind(drive: string): Promise<DestinationKind> {
  const letter = drive.slice(0, 2).toUpperCase()
  let cached = drive_kinds.get(letter)
  if (!cached) {
    cached = new Promise<DestinationKind>(resolve => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='${letter}'").DriveType`,
        ],
        { timeout: 8000, windowsHide: true },
        (error, stdout) => {
          if (error) return resolve('unknown')
          const type = Number(String(stdout).trim())
          resolve(
            type == 4 ? 'network' : type == 2 || type == 5 ? 'removable' : type == 3 || type == 6 ? 'local' : 'unknown',
          )
        },
      )
    })
    drive_kinds.set(letter, cached)
  }
  return cached
}

const NETWORK_FS = /^(smbfs|cifs|smb3|smb2|afpfs|nfs|nfs4|webdav|davfs|fuse\.sshfs|9p|ncpfs)$/i

/** macOS and Linux: the file system type of the mount that holds the path */
async function unixKind(p: string, platform: NodeJS.Platform): Promise<DestinationKind> {
  const resolved = normalize(p)
  try {
    if (platform == 'linux') {
      const mounts = (await fs.readFile('/proc/mounts', 'utf8')).split('\n').map(line => line.split(' '))
      const mount = mounts
        .filter(parts => parts.length > 2 && isInside(resolved, parts[1].replace(/\\040/g, ' '), platform))
        .sort((a, b) => b[1].length - a[1].length)[0]
      if (!mount) return 'unknown'
      if (NETWORK_FS.test(mount[2])) return 'network'
      if (/^\/(media|run\/media|mnt)\//.test(mount[1] + '/')) return 'removable'
      return 'local'
    }
    const output: string = await new Promise((resolve, reject) =>
      execFile('mount', [], { timeout: 5000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout)))),
    )
    const mounts = output
      .split('\n')
      .map(line => /^(.+) on (.+) \(([^,)]+)/.exec(line))
      .filter((m): m is RegExpExecArray => !!m)
      .filter(m => isInside(resolved, m[2], platform))
      .sort((a, b) => b[2].length - a[2].length)
    const mount = mounts[0]
    if (!mount) return 'unknown'
    if (NETWORK_FS.test(mount[3])) return 'network'
    if (mount[2].startsWith('/Volumes/')) return 'removable'
    return 'local'
  } catch {
    return 'unknown'
  }
}

export async function destinationKind(
  p: string,
  ctx: InspectContext = { project_folders: [] },
): Promise<DestinationKind> {
  const platform = ctx.platform ?? process.platform
  const resolved = normalize(p)
  if (/^\\\\|^\/\//.test(p) || /^\\\\/.test(resolved)) return 'network'
  if (platform == 'win32') {
    const drive = /^[A-Za-z]:/.exec(resolved)?.[0]
    if (!drive) return 'unknown'
    return (ctx.driveKind ?? windowsDriveKind)(drive)
  }
  return unixKind(resolved, platform)
}

/** The closest existing folder: for free space and reachability of a path still to create */
async function nearestExisting(p: string): Promise<string | undefined> {
  let current = normalize(p)
  for (let i = 0; i < 64; i++) {
    try {
      if ((await fs.stat(current)).isDirectory()) return current
    } catch {
      // keep climbing
    }
    const parent = path.dirname(current)
    if (parent == current) return undefined
    current = parent
  }
  return undefined
}

/** Can create a file, and a hard link to it, in `dir` (then removes both) */
async function probe(dir: string): Promise<{ writable: boolean; hardlinks?: boolean }> {
  const base = path.join(dir, `.opmd-probe-${randomBytes(4).toString('hex')}`)
  const file = `${base}.tmp`
  const link = `${base}.lnk`
  try {
    await fs.writeFile(file, 'probe')
  } catch {
    return { writable: false }
  }
  let hardlinks: boolean | undefined
  try {
    await fs.link(file, link)
    hardlinks = true
  } catch (error) {
    hardlinks = errorCode(error) == 'EEXIST' ? undefined : false
  }
  await unlinkQuiet(link).catch(() => undefined)
  await unlinkQuiet(file).catch(() => undefined)
  return { writable: true, hardlinks }
}

export async function inspectFolder(folder: string, ctx: InspectContext): Promise<FolderInfo> {
  const platform = ctx.platform ?? process.platform
  const resolved = normalize(folder)
  const problems: FolderProblem[] = []
  let problem_detail: string | undefined
  const info: FolderInfo = {
    path: resolved,
    kind: 'unknown',
    exists: false,
    writable: false,
    problems,
    inspected_at: new Date().toISOString(),
  }

  if (isProtectedPath(resolved, platform)) problems.push('protected')
  for (const other of ctx.project_folders) {
    if (ctx.project_id && other.id == ctx.project_id) continue
    if (isInside(resolved, other.folder, platform) || isInside(other.folder, resolved, platform)) {
      problems.push('used_by_other_project')
      problem_detail = other.id
      break
    }
  }

  info.kind = await destinationKind(folder, { ...ctx, platform })

  // Reachability: the root of the path (drive or \\server\share) must answer, quickly
  const root = /^\\\\[^\\]+\\[^\\]+/.exec(resolved)?.[0] ?? path.parse(resolved).root
  if (!(await reachable(root, ctx.reach_timeout_ms ?? REACH_TIMEOUT_MS))) {
    problems.push('unreachable')
    info.problems = dedupe(problems)
    info.problem_detail = problem_detail
    return info
  }

  try {
    const stat = await fs.stat(resolved)
    info.exists = stat.isDirectory()
    if (!info.exists) problems.push('not_writable')
  } catch (error) {
    if (!isNotFound(error)) problems.push('unreachable')
  }

  const existing = info.exists ? resolved : await nearestExisting(resolved)
  if (existing) {
    try {
      const stats = await fs.statfs(existing)
      info.free_bytes = Number(stats.bavail) * Number(stats.bsize)
    } catch {
      // Not every file system answers statfs
    }
  }

  if (info.exists) {
    const data_dir = path.join(resolved, DATA_DIR)
    const has_data = await fs
      .stat(data_dir)
      .then(s => s.isDirectory())
      .catch(() => false)
    const result = await probe(has_data ? data_dir : resolved)
    info.writable = result.writable
    info.hardlinks = result.hardlinks
    if (!result.writable) problems.push('not_writable')

    // Entries the app did not create
    const own = new Set<string>()
    if (has_data && (await dataDirOwner(data_dir).catch(() => 'ours')) == 'foreign') {
      problems.push('foreign_data')
    } else if (has_data) {
      // Unreadable now, or of a newer version of the app: the job will tell
      const loaded = await Manifest.load(data_dir, ctx.project_id ?? '').catch(() => undefined)
      for (const [name] of loaded?.manifest.entries() ?? []) own.add(nameKey(name))
      info.onpage_project = loaded?.manifest.onpage_project
      const lock = await readLock(data_dir)
      if (lock && lock.instance_id != ctx.instance_id && !isStale(lock, Date.now())) {
        problems.push('locked')
        problem_detail ??= lock.host
      }
    }
    try {
      const entries = await fs.readdir(resolved)
      info.foreign_entries = entries.filter(
        name => nameKey(name) != DATA_DIR && !name.startsWith('.opmd-') && !own.has(nameKey(name)),
      ).length
    } catch {
      // Listed above through the probe; a failure here is not a problem of its own
    }
  } else if (existing) {
    // To be created: the closest existing parent must accept it
    const result = await probe(existing)
    info.writable = result.writable
    info.hardlinks = result.hardlinks
    if (!result.writable) problems.push('not_writable')
  } else {
    problems.push('unreachable')
  }

  info.problems = dedupe(problems)
  info.problem_detail = problem_detail
  return info
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}
