/** Temporary folders for tests, removed after each test file */
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

const created: string[] = []

export async function tempDir(prefix = 'opmd-test-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  created.push(dir)
  return dir
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(
    created
      .splice(0)
      .map(dir =>
        fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
      ),
  )
}

export async function writeFiles(
  dir: string,
  files: Record<string, string | Buffer>,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await fs.writeFile(path.join(dir, name), content)
  }
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort()
  } catch {
    return []
  }
}
