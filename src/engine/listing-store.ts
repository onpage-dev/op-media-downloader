/**
 * What the last listing of each project found. In memory, the listing and
 * its names (100+ MB with 200k files) for `max_age_ms` only: «Scarica»
 * reuses them meanwhile, then they are dropped. On disk
 * (userData/cache/<project>.json.gz), the index for incremental listings and
 * for the duplicates tab after a restart. One copy of the names per project:
 * names read from the disk while a listing runs are not kept, the listing
 * brings new ones.
 */
import path from 'path'
import { Schema } from 'onpage-js'
import { ProjectId } from '../shared/models'
import { unlinkQuiet } from './fsx'
import { ListingResult } from './listing'
import { resolveNames, ResolvedNames } from './names'
import { readIndexCache, RemoteIndex, writeIndexCache } from './remote-index'

export interface Listed {
  token: string
  listing: ListingResult
  resolved: ResolvedNames
  at: number
}

interface Kept {
  token: string
  /** Missing for names resolved from the cache on disk */
  listing?: ListingResult
  resolved?: ResolvedNames
  /** Loaded for the labels of the duplicates tab, when there is no listing */
  schema?: Schema
  at: number
  timer: NodeJS.Timeout
}

export interface ListingStoreOptions {
  /** userData/cache, known once main sent `init` */
  cache_dir: () => string | undefined
  max_age_ms: number
  now: () => number
}

export class ListingStore {
  private kept = new Map<ProjectId, Kept>()
  private listing = new Set<ProjectId>()

  constructor(private options: ListingStoreOptions) {}

  cacheFile(id: ProjectId): string | undefined {
    const dir = this.options.cache_dir()
    if (!dir) return undefined
    return path.join(dir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json.gz`)
  }

  async readCache(id: ProjectId): Promise<RemoteIndex | undefined> {
    const file = this.cacheFile(id)
    return file ? readIndexCache(file) : undefined
  }

  async writeCache(id: ProjectId, index: RemoteIndex): Promise<void> {
    const file = this.cacheFile(id)
    if (file) await writeIndexCache(file, index)
  }

  async removeCache(id: ProjectId): Promise<void> {
    const file = this.cacheFile(id)
    if (file) await unlinkQuiet(file).catch(() => undefined)
  }

  /** A complete listing of this token, younger than max_age */
  fresh(id: ProjectId, token: string): Listed | undefined {
    const kept = this.kept.get(id)
    if (!kept?.listing || !kept.resolved || kept.token != token) return undefined
    if (!kept.listing.complete) return undefined
    if (this.options.now() - kept.at >= this.options.max_age_ms) return undefined
    return { token, listing: kept.listing, resolved: kept.resolved, at: kept.at }
  }

  /** A listing starts: what it replaces goes now, not when it ends */
  begin(id: ProjectId): void {
    this.drop(id)
    this.listing.add(id)
  }

  /** The listing ended, done or not */
  end(id: ProjectId): void {
    this.listing.delete(id)
  }

  keep(id: ProjectId, listed: Omit<Listed, 'at'>): Listed {
    const kept = this.put(id, { token: listed.token, listing: listed.listing, resolved: listed.resolved })
    return { ...listed, at: kept.at }
  }

  /**
   * The names of the last listing of this token, or of the cache on disk:
   * resolved once (seconds with 100k+ files) and kept for max_age
   */
  async resolved(id: ProjectId, token: string): Promise<ResolvedNames | undefined> {
    const kept = this.kept.get(id)
    if (kept?.token == token && kept.resolved) return kept.resolved
    const cache = await this.readCache(id)
    if (!cache) return undefined
    const resolved = resolveNames(cache)
    if (!this.listing.has(id)) this.put(id, { token, resolved })
    return resolved
  }

  /** The schema of the last listing, or loaded once for the names kept */
  async schema(id: ProjectId, token: string, load: () => Promise<Schema>): Promise<Schema> {
    const kept = this.kept.get(id)
    if (kept?.token == token && (kept.listing || kept.schema))
      return kept.listing?.schema ?? kept.schema!
    const schema = await load()
    const now_kept = this.kept.get(id)
    if (now_kept?.token == token && !now_kept.listing) now_kept.schema = schema
    return schema
  }

  forget(id: ProjectId): void {
    this.drop(id)
  }

  private put(id: ProjectId, entry: Omit<Kept, 'at' | 'timer'>): Kept {
    this.drop(id)
    const timer = setTimeout(() => this.drop(id), this.options.max_age_ms)
    timer.unref()
    const kept: Kept = { ...entry, at: this.options.now(), timer }
    this.kept.set(id, kept)
    return kept
  }

  private drop(id: ProjectId): void {
    const kept = this.kept.get(id)
    if (!kept) return
    clearTimeout(kept.timer)
    this.kept.delete(id)
  }
}
