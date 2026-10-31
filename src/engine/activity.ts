/**
 * The last events of a project for the «Attività» tab, and the complete list
 * of what failed in the last run for «Falliti» and «Riprova i falliti».
 */
import { ActivityEntry, FailedEntry } from '../shared/models'

const MAX_ENTRIES = 1000
/** In-flight progress is sent again only after this much change */
const PROGRESS_STEP = 0.05

export class ActivityLog {
  private entries: ActivityEntry[] = []
  private by_id = new Map<number, ActivityEntry>()
  private changed = new Map<number, ActivityEntry>()
  private next_id = 1

  constructor(private now = Date.now) {}

  add(entry: Omit<ActivityEntry, 'id' | 'at'>): ActivityEntry {
    const full: ActivityEntry = {
      ...entry,
      id: this.next_id++,
      at: new Date(this.now()).toISOString(),
    }
    this.entries.push(full)
    this.by_id.set(full.id, full)
    if (this.entries.length > MAX_ENTRIES) {
      const dropped = this.entries.splice(0, this.entries.length - MAX_ENTRIES)
      for (const old of dropped) this.by_id.delete(old.id)
    }
    this.changed.set(full.id, full)
    return full
  }

  /** Updates an entry in place (in-flight progress, final outcome) */
  update(id: number, patch: Partial<Omit<ActivityEntry, 'id'>>): void {
    const entry = this.by_id.get(id)
    if (!entry) return
    const progress_only =
      Object.keys(patch).length == 1 && patch.progress !== undefined
    if (
      progress_only &&
      Math.abs((patch.progress ?? 0) - (entry.progress ?? 0)) < PROGRESS_STEP
    ) {
      entry.progress = patch.progress
      return
    }
    Object.assign(entry, patch)
    this.changed.set(id, entry)
  }

  recent(limit = MAX_ENTRIES): ActivityEntry[] {
    return this.entries.slice(-limit).map(e => ({ ...e }))
  }

  /** Entries added or changed since the last call, oldest first */
  takeChanged(): ActivityEntry[] {
    if (!this.changed.size) return []
    const out = Array.from(this.changed.values())
      .sort((a, b) => a.id - b.id)
      .map(e => ({ ...e }))
    this.changed.clear()
    return out
  }
}

export class FailedList {
  private items = new Map<string, FailedEntry>()

  set(entry: FailedEntry): void {
    this.items.set(entry.name, entry)
  }

  delete(name: string): void {
    this.items.delete(name)
  }

  clear(): void {
    this.items.clear()
  }

  get size(): number {
    return this.items.size
  }

  list(): FailedEntry[] {
    return Array.from(this.items.values())
  }

  /** Real failures, the ones «Riprova i falliti» can fix (not conflicts) */
  retryable(): FailedEntry[] {
    return this.list().filter(
      e => e.reason != 'name_conflict' && e.reason != 'invalid_name',
    )
  }

  conflicts(): number {
    return this.list().filter(e => e.reason == 'name_conflict').length
  }
}
