/**
 * What main sees of a project: the runtime (phase, plan, progress, issues),
 * sent at most every `state_interval_ms` (a new phase at once), and the
 * activity in batches while a job runs. The counts of the plan's issues
 * (duplicates, conflicts, removals to confirm) are read from the plan
 * itself, so the two never disagree.
 */
import { EngineToMain } from '../shared/engine-protocol'
import {
  Issue,
  IssueCode,
  JobKind,
  JobPhase,
  ProjectId,
  ProjectRuntime,
  SyncResult,
} from '../shared/models'
import { ActivityLog, FailedList } from './activity'
import { Summary } from './plan'
import { ProgressTracker } from './progress'

export interface StateOptions {
  post: (message: EngineToMain) => void
  now: () => number
  state_interval_ms: number
  activity_interval_ms: number
}

export class ProjectState {
  readonly runtime: ProjectRuntime = { phase: 'idle', issues: [] }
  progress?: ProgressTracker
  /** The problem that ended the last job */
  job_issues: Issue[] = []
  /** On Page asked to slow down during this job */
  rate_limited = false
  /** The folder copies instead of linking */
  copies = false
  /** The collections the last listing could not read (until a complete one) */
  incomplete?: string
  private closed = false
  private last_sent = 0
  private timer?: NodeJS.Timeout
  private batches?: NodeJS.Timeout

  constructor(
    readonly id: ProjectId,
    private activity: ActivityLog,
    private failed: FailedList,
    private options: StateOptions,
  ) {}

  /** Forgotten: nothing more is sent */
  get isClosed(): boolean {
    return this.closed
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    clearInterval(this.batches)
  }

  /** A job starts: no issue of the last job, activity in batches */
  begin(kind: JobKind): void {
    this.job_issues = []
    this.rate_limited = false
    this.runtime.job = kind
    this.batches = setInterval(
      () => this.flushActivity(),
      this.options.activity_interval_ms,
    )
    this.setPhase('preparing')
  }

  /** The job ended: the last activity, the final state, then the result */
  end(result: SyncResult): void {
    clearInterval(this.batches)
    this.batches = undefined
    this.flushActivity()
    this.progress = undefined
    this.rate_limited = false
    this.runtime.job = undefined
    this.runtime.last_result = result
    this.runtime.phase = 'idle'
    this.emit(true)
    if (!this.closed)
      this.options.post({ kind: 'result', project_id: this.id, result })
  }

  /** «Interruzione» stays until the job ends */
  setPhase(phase: JobPhase): void {
    if (this.runtime.phase == 'stopping' && phase != 'idle') return
    this.runtime.phase = phase
    this.emit(true)
  }

  setPlan(summary: Summary): void {
    this.runtime.plan = { ...summary, created_at: this.iso() }
  }

  /** Throttled; `force` sends now (a new phase, the end of a job) */
  emit(force = false): void {
    if (this.closed) return
    const wait =
      this.options.state_interval_ms - (this.options.now() - this.last_sent)
    if (force || wait <= 0) {
      clearTimeout(this.timer)
      this.send()
    } else {
      this.timer ??= setTimeout(() => this.send(), wait)
    }
  }

  flushActivity(): void {
    if (this.closed) return
    const entries = this.activity.takeChanged()
    if (entries.length)
      this.options.post({ kind: 'activity', project_id: this.id, entries })
  }

  private send(): void {
    this.timer = undefined
    // A timer armed before the project was forgotten
    if (this.closed) return
    this.last_sent = this.options.now()
    this.runtime.issues = this.issues()
    this.runtime.progress = this.progress?.snapshot()
    this.options.post({
      kind: 'state',
      project_id: this.id,
      runtime: structuredClone(this.runtime),
    })
  }

  private issues(): Issue[] {
    const at = this.iso()
    const out: Issue[] = [...this.job_issues]
    const warn = (code: IssueCode, count?: number, detail?: string): void => {
      const issue: Issue = { code, severity: 'warning', count, at }
      if (detail !== undefined) issue.detail = detail
      out.push(issue)
    }
    const plan = this.runtime.plan
    if (this.rate_limited && this.runtime.job) warn('rate_limited')
    if (plan?.cleanup_needs_confirmation)
      warn('cleanup_needs_confirmation', plan.to_remove)
    if (this.incomplete !== undefined)
      warn('listing_incomplete', undefined, this.incomplete)
    const failed = this.failed.retryable().length
    if (failed) warn('failed_files', failed)
    if (plan?.duplicates) warn('duplicates', plan.duplicates)
    if (plan?.conflicts) warn('name_conflicts', plan.conflicts)
    if (this.copies) warn('copies_instead_of_links')
    return out
  }

  private iso(): string {
    return new Date(this.options.now()).toISOString()
  }
}
