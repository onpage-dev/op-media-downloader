import { promises as fs } from 'fs'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { JobError } from './errors'
import { FolderLock, readLock } from './lock'
import { LINK_JSON_FILE, Manifest, MANIFEST_FILE } from './manifest'
import { cleanupTempDirs, listDir, tempDir } from './testing/tmp'

afterAll(cleanupTempDirs)

describe('manifest', () => {
  it('writes atomically and reads back', async () => {
    const dir = await tempDir()
    const { manifest, source } = await Manifest.load(dir, 'p1')
    expect(source).toBe('empty')
    manifest.set('a.jpg', {
      token: 't1',
      size: 10,
      mode: 'link',
      remote_name: 'a.jpg',
    })
    manifest.set('b.jpg', { token: 't2', mode: 'copy' })
    await manifest.flush()
    expect(await listDir(dir)).toEqual([MANIFEST_FILE])
    const again = await Manifest.load(dir, 'p1')
    expect(again.source).toBe('manifest')
    expect(again.manifest.entries()).toEqual(manifest.entries())
  })

  it('imports 1.x link.json, skipping names that could never exist and unsafe tokens', async () => {
    const dir = await tempDir()
    const link_json = {
      'a.jpg': 'tok-a',
      'b:c.jpg': 'tok-b',
      'd.jpg': '../evil',
      'e.jpg': 'tok-e',
    }
    await fs.writeFile(
      path.join(dir, LINK_JSON_FILE),
      JSON.stringify(link_json),
    )
    const { manifest, source } = await Manifest.load(dir, 'p1')
    expect(source).toBe('link.json')
    expect(
      manifest.entries().map(([name, e]) => [name, e.token, e.mode]),
    ).toEqual([
      ['a.jpg', 'tok-a', 'unknown'],
      ['e.jpg', 'tok-e', 'unknown'],
    ])
    expect(manifest.dirty).toBe(true)
    await manifest.flush()
    // link.json is left alone, the manifest takes over
    expect(
      JSON.parse(await fs.readFile(path.join(dir, LINK_JSON_FILE), 'utf8')),
    ).toEqual(link_json)
    expect((await Manifest.load(dir, 'p1')).source).toBe('manifest')
  })

  it('a broken manifest falls back to link.json, or to empty, without throwing', async () => {
    const dir = await tempDir()
    await fs.writeFile(
      path.join(dir, MANIFEST_FILE),
      '{"version":2,"files":{"a.jpg":',
    )
    let load = await Manifest.load(dir, 'p1')
    expect(load).toMatchObject({ source: 'empty', recovered: true })
    await fs.writeFile(
      path.join(dir, LINK_JSON_FILE),
      JSON.stringify({ 'x.jpg': 'tx' }),
    )
    load = await Manifest.load(dir, 'p1')
    expect(load).toMatchObject({ source: 'link.json', recovered: true })
    expect(load.manifest.size).toBe(1)
  })

  it('a name that changes case replaces its entry', async () => {
    const { manifest } = await Manifest.load(await tempDir(), 'p1')
    manifest.set('foto.jpg', { token: 't1', mode: 'link' })
    manifest.set('Foto.jpg', { token: 't1', mode: 'link' })
    expect(manifest.entries().map(([n]) => n)).toEqual(['Foto.jpg'])
    expect(manifest.byKey('foto.jpg')?.[0]).toBe('Foto.jpg')
  })

  it('checkpoints wait for enough changes and time', async () => {
    const dir = await tempDir()
    const { manifest } = await Manifest.load(dir, 'p1')
    manifest.set('a.jpg', { token: 't1', mode: 'link' })
    await manifest.checkpoint()
    expect(await listDir(dir)).toEqual([])
    await manifest.flush()
    expect(await listDir(dir)).toEqual([MANIFEST_FILE])
  })
})

describe('folder lock', () => {
  it('one instance at a time; released by its owner', async () => {
    const dir = await tempDir()
    const lock = await FolderLock.acquire(dir, {
      instance_id: 'A',
      project_id: 'p1',
    })
    expect((await readLock(dir))?.instance_id).toBe('A')
    const other = FolderLock.acquire(dir, {
      instance_id: 'B',
      project_id: 'p1',
    })
    await expect(other).rejects.toBeInstanceOf(JobError)
    await expect(other).rejects.toMatchObject({ issue: 'folder_locked' })
    await lock.release()
    expect(await readLock(dir)).toBeUndefined()
    const lock_b = await FolderLock.acquire(dir, {
      instance_id: 'B',
      project_id: 'p1',
    })
    await lock_b.release()
  })

  it('a lock left by the same instance and project is taken over', async () => {
    const dir = await tempDir()
    await FolderLock.acquire(dir, {
      instance_id: 'A',
      project_id: 'p1',
      heartbeat_ms: 60_000,
    })
    const again = await FolderLock.acquire(dir, {
      instance_id: 'A',
      project_id: 'p1',
    })
    await again.release()
  })

  it('the same instance on another project is locked out', async () => {
    const dir = await tempDir()
    const lock = await FolderLock.acquire(dir, {
      instance_id: 'A',
      project_id: 'p1',
    })
    await expect(
      FolderLock.acquire(dir, { instance_id: 'A', project_id: 'p2' }),
    ).rejects.toMatchObject({ issue: 'folder_locked' })
    await lock.release()
  })

  it('a stale lock (no heartbeat) is taken over', async () => {
    const dir = await tempDir()
    const old = new Date(Date.now() - 10 * 60_000).toISOString()
    await fs.writeFile(
      path.join(dir, '.lock'),
      JSON.stringify({
        host: 'altro-pc',
        pid: 1,
        instance_id: 'X',
        project_id: 'p1',
        started_at: old,
        heartbeat_at: old,
      }),
    )
    const lock = await FolderLock.acquire(dir, {
      instance_id: 'A',
      project_id: 'p1',
    })
    expect((await readLock(dir))?.host).not.toBe('altro-pc')
    await lock.release()
  })

  it('the heartbeat refreshes the lock, and notices when it was taken', async () => {
    const dir = await tempDir()
    const lock = await FolderLock.acquire(dir, {
      instance_id: 'A',
      project_id: 'p1',
      heartbeat_ms: 40,
    })
    const first = (await readLock(dir))!.heartbeat_at
    await new Promise(resolve => setTimeout(resolve, 150))
    expect((await readLock(dir))!.heartbeat_at > first).toBe(true)
    // Another instance takes the folder (and keeps beating)
    const theirs = JSON.stringify({
      ...(await readLock(dir)),
      instance_id: 'Z',
    })
    for (let i = 0; i < 50 && !lock.lost; i++) {
      await fs.writeFile(path.join(dir, '.lock'), theirs)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(lock.lost).toBe(true)
    await fs.writeFile(path.join(dir, '.lock'), theirs)
    await lock.release()
    // A lost lock is not ours to remove
    expect((await readLock(dir))?.instance_id).toBe('Z')
  })
})
