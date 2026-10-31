import { promises as fs } from 'fs'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { dataDirOwner, isOwnDataEntry, removeOwnDataEntries } from './data-dir'
import { cleanupTempDirs, listDir, tempDir, writeFiles } from './testing/tmp'

const TOKEN = 'e4f0e64e9d56231bda0efc5aae8e00a5ee0bce3a'

afterAll(cleanupTempDirs)

describe('data/ ownership', () => {
  it('is missing when there is no data folder', async () => {
    const folder = await tempDir()
    expect(await dataDirOwner(path.join(folder, 'data'))).toBe('missing')
  })

  it('is ours with the manifest or the 1.x link.json', async () => {
    const with_manifest = await tempDir()
    await writeFiles(with_manifest, { 'data/manifest.json': '{}', 'data/report.pdf': 'x' })
    expect(await dataDirOwner(path.join(with_manifest, 'data'))).toBe('ours')

    const with_link = await tempDir()
    await writeFiles(with_link, { 'data/link.json': '{}' })
    expect(await dataDirOwner(path.join(with_link, 'data'))).toBe('ours')
  })

  it('is ours with only tokens and service files (a 1.x download stopped before link.json)', async () => {
    const folder = await tempDir()
    await writeFiles(folder, {
      [`data/${TOKEN}`]: 'a',
      [`data/${TOKEN.replace('e4', 'f5')}.jpg`]: 'b',
      [`data/${TOKEN.replace('e4', 'a1')}.download`]: 'c',
      'data/.lock': '{}',
    })
    expect(await dataDirOwner(path.join(folder, 'data'))).toBe('ours')
  })

  it('is foreign when the user already had a data folder', async () => {
    const folder = await tempDir()
    await writeFiles(folder, { 'data/report.pdf': 'mine', [`data/${TOKEN}`]: 'a' })
    expect(await dataDirOwner(path.join(folder, 'data'))).toBe('foreign')
  })

  it('recognises only tokens and service files as entries of the app', () => {
    expect(isOwnDataEntry(TOKEN)).toBe(true)
    expect(isOwnDataEntry(`${TOKEN}.webp`)).toBe(true)
    expect(isOwnDataEntry('manifest.json')).toBe(true)
    expect(isOwnDataEntry('.opmd-1a2b3c')).toBe(true)
    expect(isOwnDataEntry('report.pdf')).toBe(false)
    expect(isOwnDataEntry('Thumbs.db')).toBe(false)
  })

  it('removes only what the app put in data/, and data/ only when empty', async () => {
    const folder = await tempDir()
    const data_dir = path.join(folder, 'data')
    await writeFiles(folder, {
      [`data/${TOKEN}`]: 'a',
      'data/manifest.json': '{}',
      'data/notes.txt': 'mine',
    })
    expect(await removeOwnDataEntries(data_dir)).toEqual({ removed: 2, kept: 1 })
    expect(await listDir(data_dir)).toEqual(['notes.txt'])

    await fs.rm(path.join(data_dir, 'notes.txt'))
    await writeFiles(folder, { [`data/${TOKEN}`]: 'a' })
    await removeOwnDataEntries(data_dir)
    expect(await listDir(folder)).toEqual([])
  })
})
