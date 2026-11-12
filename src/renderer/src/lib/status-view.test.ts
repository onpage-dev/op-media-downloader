/**
 * The inspector's tiles: the last run's counters, unless a later comparison
 * with the folder knows better (a folder emptied by hand since that run).
 */
import { describe, expect, it } from 'vitest'
import type { PlanSummary, ProjectRuntime, ProjectView, SyncResult } from '@shared/models'
import { inspectorCounts } from './status-view'

function view(runtime: Partial<ProjectRuntime>): ProjectView {
  return {
    id: 'p1',
    label: 'Prova',
    folder: '/tmp/Prova',
    keep_old_files: false,
    created_at: '2026-11-12T13:00:00.000Z',
    has_token: true,
    runtime: { phase: 'idle', issues: [], ...runtime },
  }
}

const result = (ended_at: string, already_present: number, downloaded = 0): SyncResult => ({
  job: 'sync',
  started_at: ended_at,
  ended_at,
  outcome: 'completed',
  total: already_present + downloaded,
  downloaded,
  linked: 0,
  removed: 0,
  already_present,
  failed: 0,
  bytes: 0,
})

const plan = (created_at: string, up_to_date: number, remote_names: number): PlanSummary => ({
  created_at,
  remote_names,
  remote_bytes: 0,
  to_download: remote_names - up_to_date,
  to_download_names: remote_names - up_to_date,
  to_download_bytes: 0,
  to_link: 0,
  to_remove: 0,
  up_to_date,
  duplicates: 0,
  conflicts: 0,
  cleanup_needs_confirmation: false,
  listing: 'incremental',
})

describe('inspectorCounts', () => {
  it('shows the last run when its plan came with it', () => {
    const counts = inspectorCounts(
      view({
        plan: plan('2026-11-12T13:08:48.905Z', 6586, 6586),
        last_result: result('2026-11-12T13:08:48.913Z', 6586),
      }),
    )
    expect(counts).toEqual({ downloaded: 0, present: 6586, failed: 0, total: 6586 })
  })

  it('a folder deleted by hand after the run: the later comparison, never «already there»', () => {
    const counts = inspectorCounts(
      view({ plan: plan('2026-11-12T13:10:33.050Z', 0, 6586), last_result: result('2026-11-12T13:08:48.913Z', 6586) }),
    )
    expect(counts).toEqual({ downloaded: 0, present: 0, failed: 0, total: 6586 })
  })

  it('a few names deleted by hand: what is still in place', () => {
    const counts = inspectorCounts(
      view({
        plan: plan('2026-11-12T14:00:00.000Z', 6000, 6586),
        last_result: result('2026-11-12T13:08:33.523Z', 0, 6586),
        issues: [{ code: 'failed_files', severity: 'warning', at: '2026-11-12T14:00:00.000Z', count: 2 }],
      }),
    )
    expect(counts).toEqual({ downloaded: 0, present: 6000, failed: 2, total: 6586 })
  })

  it('a running job shows its own counters', () => {
    const counts = inspectorCounts(
      view({
        phase: 'downloading',
        plan: plan('2026-11-12T13:10:33.050Z', 0, 6586),
        last_result: result('2026-11-12T13:08:48.913Z', 6586),
        progress: {
          started_at: '2026-11-12T13:11:00.000Z',
          total: 6586,
          downloaded: 10,
          linked: 0,
          removed: 0,
          already_present: 0,
          failed: 0,
          bytes_done: 0,
          bytes_total: 0,
          speed_bps: 0,
          in_flight: 4,
          concurrency: 4,
        },
      }),
    )
    expect(counts).toEqual({ downloaded: 10, present: 0, failed: 0, total: 6586 })
  })

  it('never synced: nothing, the total from the plan when there is one', () => {
    expect(inspectorCounts(view({}))).toEqual({ downloaded: 0, present: 0, failed: 0, total: undefined })
  })
})
