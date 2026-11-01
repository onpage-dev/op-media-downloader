/**
 * Counters, bytes, a speed smoothed over the last seconds and the time left.
 */
import { Progress } from '../shared/models'

const WINDOW_MS = 5_000

export class ProgressTracker {
  private samples: [number, number][] = []
  readonly progress: Progress

  constructor(
    init: { total: number; bytes_total: number; concurrency: number },
    private now = Date.now,
  ) {
    this.progress = {
      started_at: new Date(now()).toISOString(),
      total: init.total,
      downloaded: 0,
      linked: 0,
      removed: 0,
      already_present: 0,
      failed: 0,
      bytes_done: 0,
      bytes_total: init.bytes_total,
      speed_bps: 0,
      in_flight: 0,
      concurrency: init.concurrency,
    }
  }

  addBytes(delta: number): void {
    this.progress.bytes_done = Math.max(0, this.progress.bytes_done + delta)
    if (this.progress.bytes_done > this.progress.bytes_total) {
      this.progress.bytes_total = this.progress.bytes_done
    }
  }

  /** A size learned only from Content-Length */
  addBytesTotal(delta: number): void {
    this.progress.bytes_total += delta
  }

  count(kind: 'downloaded' | 'linked' | 'removed' | 'already_present' | 'failed', n = 1): void {
    this.progress[kind] += n
  }

  /** A copy with speed and time left updated */
  snapshot(): Progress {
    const now = this.now()
    this.samples.push([now, this.progress.bytes_done])
    while (this.samples.length > 2 && now - this.samples[0][0] > WINDOW_MS) this.samples.shift()
    const [t0, b0] = this.samples[0]
    const elapsed = (now - t0) / 1000
    if (elapsed >= 0.5) this.progress.speed_bps = Math.max(0, (this.progress.bytes_done - b0) / elapsed)
    const left = this.progress.bytes_total - this.progress.bytes_done
    this.progress.eta_seconds =
      this.progress.speed_bps > 0 && left > 0 ? Math.round(left / this.progress.speed_bps) : undefined
    return {
      ...this.progress,
      listing: this.progress.listing && { ...this.progress.listing },
    }
  }
}
