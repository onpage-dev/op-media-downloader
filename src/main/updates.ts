/** Looks for a newer release on GitHub (through Chromium's network stack, proxy included) */
import { app, net } from 'electron'
import { VersionInfo } from '../shared/models'
import { log } from './log'

const LATEST_RELEASE = 'https://api.github.com/repos/onpage-dev/op-media-downloader/releases/latest'

let info: VersionInfo = { current: app.getVersion() }

export function versionInfo(): VersionInfo {
  return info
}

export async function checkForUpdates(): Promise<VersionInfo> {
  try {
    const response = await net.fetch(LATEST_RELEASE, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
    const release = (await response.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean }
    const latest = release.tag_name?.replace(/^v/i, '')
    info = {
      current: app.getVersion(),
      latest: latest && isNewer(latest, app.getVersion()) ? latest : undefined,
      release_url: release.html_url,
      checked_at: new Date().toISOString(),
    }
  } catch (error) {
    log('warn', 'Update check failed', error)
    info = { ...info, checked_at: new Date().toISOString(), check_failed: true }
  }
  return info
}

/** Semantic comparison of `x.y.z` versions; anything unparsable is not newer */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (version: string): number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
    return match ? match.slice(1, 4).map(Number) : undefined
  }
  const a = parse(candidate)
  const b = parse(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] != b[i]) return a[i] > b[i]
  }
  return false
}
