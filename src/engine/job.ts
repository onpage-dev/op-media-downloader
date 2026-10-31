/**
 * A job of a project, the slot that keeps a project between jobs, and what
 * a job sees of the engine. Two signals end a job early: the user's stop,
 * and the job's own abort, fired by a fatal error or by the loss of the
 * folder lock. Everything in flight listens to both (`signal`).
 */
import { EngineProject, EngineToMain } from '../shared/engine-protocol'
import { JobKind, OnPageProject, ProjectId } from '../shared/models'
import { ActivityLog, FailedList } from './activity'
import { AbortedError, JobError } from './errors'
import { FetchLike } from './http'
import { ListingStore } from './listing-store'
import { OnPageContext } from './onpage'
import { ProjectState } from './state'
import { EngineTimings } from './timings'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export class Job {
  /** Fires on the user's stop and on the job's failure */
  readonly signal: AbortSignal
  /** Settles when the job has ended and its result was sent */
  done: Promise<void> = Promise.resolve()
  /** The job's On Page project, once the folder's registry on the disk names it */
  folder_project?: OnPageProject
  private stop_controller = new AbortController()
  private fail_controller = new AbortController()

  constructor(
    readonly kind: JobKind,
    readonly project: EngineProject,
    readonly started_at: string,
  ) {
    this.signal = AbortSignal.any([this.stop_controller.signal, this.fail_controller.signal])
  }

  /** The user's stop: what is in flight aborts, what is done stays */
  stop(): void {
    this.stop_controller.abort(new AbortedError())
  }

  get stopped(): boolean {
    return this.stop_controller.signal.aborted
  }

  /** Ends the job with this error (the first one counts): what is in flight aborts */
  fail(error: JobError): void {
    if (!this.fail_controller.signal.aborted) this.fail_controller.abort(error)
  }

  /** The error that ended the job early */
  get failure(): JobError | undefined {
    const signal = this.fail_controller.signal
    return signal.aborted ? (signal.reason as JobError) : undefined
  }

  /** Throws when the job is over: its failure, or AbortedError after a stop */
  check(): void {
    const failure = this.failure
    if (failure) throw failure
    if (this.stopped) throw new AbortedError()
  }
}

/** What the engine keeps about a project between jobs */
export class ProjectSlot {
  readonly activity: ActivityLog
  readonly failed = new FailedList()
  readonly state: ProjectState
  job?: Job
  /** delete_project_files is emptying the folder: no job starts meanwhile */
  deleting?: Promise<unknown>
  /** The removals the last plan held back, as the user saw them: what «Conferma» covers */
  withheld: readonly string[] = []

  constructor(
    readonly id: ProjectId,
    options: {
      post: (message: EngineToMain) => void
      now: () => number
      timings: EngineTimings
    },
  ) {
    this.activity = new ActivityLog(options.now)
    this.state = new ProjectState(id, this.activity, this.failed, {
      post: options.post,
      now: options.now,
      state_interval_ms: options.timings.state_interval_ms,
      activity_interval_ms: options.timings.activity_interval_ms,
    })
  }

  /** A job runs, or the files are being deleted */
  get busy(): boolean {
    return !!this.job || !!this.deleting
  }
}

/** The engine as a job sees it */
export interface EngineServices {
  readonly timings: EngineTimings
  readonly fetch: FetchLike
  readonly listings: ListingStore
  now(): number
  log(level: LogLevel, message: string, project_id?: ProjectId): void
  /** Parallel downloads, 1..10 */
  concurrency(): number
  /** For the folder lock */
  instanceId(): string
  apiDomain(): string
  projectFolders(): { id: ProjectId; folder: string }[]
  onPageContext(signal?: AbortSignal, onRetry?: OnPageContext['onRetry']): OnPageContext
}

/** What a flow works with */
export interface JobContext {
  readonly engine: EngineServices
  readonly slot: ProjectSlot
  readonly job: Job
}
