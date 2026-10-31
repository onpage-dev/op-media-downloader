import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  destinationKind,
  inspectFolder,
  InspectContext,
  isInside,
  isProtectedPath,
} from './folder-inspect'
import { FolderLock } from './lock'
import { Manifest } from './manifest'
import { cleanupTempDirs, listDir, tempDir, writeFiles } from './testing/tmp'

afterAll(cleanupTempDirs)

const local: InspectContext = {
  project_folders: [],
  driveKind: async () => 'local',
}
const IS_WIN = process.platform == 'win32'

describe('protected paths and overlaps', () => {
  it('drive roots, home and system folders are protected; share roots are not', () => {
    expect(isProtectedPath(path.parse(process.cwd()).root)).toBe(true)
    expect(isProtectedPath(os.homedir())).toBe(true)
    expect(isProtectedPath(path.join(os.homedir(), 'Documents', 'Media'))).toBe(
      false,
    )
    if (IS_WIN) {
      expect(isProtectedPath('C:\\Windows\\System32\\x', 'win32')).toBe(true)
      expect(isProtectedPath('C:\\Program Files\\App', 'win32')).toBe(true)
      expect(isProtectedPath('\\\\nas\\media\\', 'win32')).toBe(false)
      expect(isProtectedPath('D:\\', 'win32')).toBe(true)
    }
  })

  it('a folder inside another is detected both ways, case-insensitively on Windows', () => {
    const base = path.resolve('/tmp/progetti/a')
    expect(isInside(path.join(base, 'sub'), base)).toBe(true)
    expect(isInside(base, path.join(base, 'sub'))).toBe(false)
    expect(isInside(base + '-bis', base)).toBe(false)
    if (IS_WIN)
      expect(isInside('C:\\Media\\X', 'c:\\media', 'win32')).toBe(true)
  })
})

describe('inspectFolder', () => {
  it('an empty local folder: writable, links supported, no leftovers', async () => {
    const dir = await tempDir()
    const info = await inspectFolder(dir, local)
    expect(info).toMatchObject({
      exists: true,
      writable: true,
      hardlinks: true,
      kind: 'local',
      problems: [],
      foreign_entries: 0,
    })
    expect(info.free_bytes).toBeGreaterThan(0)
    expect(await listDir(dir)).toEqual([])
  })

  it('a folder still to create is judged by its parent', async () => {
    const dir = path.join(await tempDir(), 'nuova', 'cartella')
    const info = await inspectFolder(dir, local)
    expect(info).toMatchObject({ exists: false, writable: true, problems: [] })
    await expect(fs.stat(dir)).rejects.toThrow()
  })

  it('counts the entries the app did not create', async () => {
    const dir = await tempDir()
    await writeFiles(dir, {
      'a.jpg': 'x',
      'b.jpg': 'x',
      'appunti.docx': 'x',
      'altro/file.txt': 'x',
    })
    const { manifest } = await Manifest.load(path.join(dir, 'data'), 'p1')
    manifest.set('a.jpg', { token: 't1', mode: 'link' })
    manifest.set('b.jpg', { token: 't2', mode: 'link' })
    await manifest.flush()
    const info = await inspectFolder(dir, { ...local, project_id: 'p1' })
    expect(info.foreign_entries).toBe(2)
    expect(info.problems).toEqual([])
  })

  it('a folder of another project, inside it or around it, is refused', async () => {
    const dir = await tempDir()
    const sub = path.join(dir, 'sotto')
    const context: InspectContext = {
      ...local,
      project_id: 'mine',
      project_folders: [
        { id: 'other', folder: dir },
        { id: 'mine', folder: sub },
      ],
    }
    const info = await inspectFolder(sub, context)
    expect(info.problems).toContain('used_by_other_project')
    expect(info.problem_detail).toBe('other')
    // Its own folder is fine
    const own = await inspectFolder(dir, {
      ...local,
      project_id: 'other',
      project_folders: [{ id: 'other', folder: dir }],
    })
    expect(own.problems).toEqual([])
  })

  it('a folder another instance is syncing is reported as locked', async () => {
    const dir = await tempDir()
    await fs.mkdir(path.join(dir, 'data'))
    const lock = await FolderLock.acquire(path.join(dir, 'data'), {
      instance_id: 'other-pc',
      project_id: 'p1',
    })
    const info = await inspectFolder(dir, { ...local, instance_id: 'me' })
    expect(info.problems).toContain('locked')
    await lock.release()
  })

  it.runIf(IS_WIN)(
    'a share is a network folder; an unreachable one is reported',
    async () => {
      const dir = await tempDir()
      const unc = '\\\\localhost\\' + dir.replace(/^([A-Z]):/i, '$1$')
      expect(await destinationKind(unc)).toBe('network')
      const info = await inspectFolder('\\\\10.255.255.1\\media\\vasi', local)
      expect(info.kind).toBe('network')
      expect(info.problems).toContain('unreachable')
    },
  )
})
