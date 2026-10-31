/**
 * Executes a plan: renames and links first (fast, no network), then the
 * downloads (one per token, then linked to all its names), then removals.
 * Per-file failures are recorded and the run goes on; disk full, a folder
 * that disappears or becomes read-only end the run: the job fails at once
 * (`fail`), so the transfers in flight stop too, and nothing more is placed
 * or checkpointed. The same once the folder lock is lost (`guard`).
 */
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { FailureCode } from '../shared/models'
import { ActivityLog, FailedList } from './activity'
import { downloadToFile } from './download'
import {
  AbortedError,
  ConflictError,
  errorCode,
  errorDetail,
  failureCode,
  FOLDER_GONE_CODES,
  HttpError,
  JobError,
  NOT_WRITABLE_CODES,
} from './errors'
import { freeSpace, reachable, unlinkQuiet } from './fsx'
import { DOWNLOAD_RETRY, FetchLike, RetryPolicy, withRetry } from './http'
import {
  LinkCapability,
  placeName,
  probeHardLinks,
  removeName,
  renameName,
} from './link'
import { Manifest } from './manifest'
import { DownloadTask, LinkTask, Plan } from './plan'
import { ProgressTracker } from './progress'
import { runQueue } from './queue'

export interface ExecuteContext {
  folder: string
  data_dir: string
  manifest: Manifest
  plan: Plan
  fetch: FetchLike
  storageUrl: (token: string, remote_name: string) => string
  concurrency: number
  signal: AbortSignal
  progress: ProgressTracker
  activity: ActivityLog
  failed: FailedList
  /** Links or copies: probed before the first name is placed, unless known */
  capability: LinkCapability
  policy?: RetryPolicy
  headers_timeout_ms?: number
  idle_timeout_ms?: number
  onChange?: () => void
  /** Called when a stage starts: links (renames and links), downloads, removals */
  onStage?: (stage: 'links' | 'downloads' | 'removals') => void
  onRateLimited?: (delay_ms: number) => void
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
  /** Throws when the folder is not the job's to write any more: its lock went to another computer */
  guard?: () => void
  /** Ends the job with a fatal error: `signal` fires, the transfers in flight abort */
  fail?: (error: JobError) => void
  /** How long a folder may take to answer before it counts as gone */
  reach_timeout_ms?: number
}

export interface ExecuteResult {
  downloaded: number
  linked: number
  removed: number
  failed: number
  conflicts: number
  copies: number
  bytes: number
}

/** A disk with less than this left is full, whatever it said */
const FULL_MARGIN = 16 * 1024 * 1024

/**
 * Turns a file system error into the end of the run when it is not about one
 * file: the disk is full, the folder is gone (a share, an unplugged disk) or
 * read-only. ENOSPC with plenty of room left is a limit on one file (4 GB on
 * FAT32): that file fails, the run goes on.
 */
async function fatalError(
  error: unknown,
  ctx: ExecuteContext,
  size?: number,
): Promise<JobError | undefined> {
  if (error instanceof JobError) return error
  const code = errorCode(error) ?? ''
  const detail = errorDetail(error)
  if (code == 'EDQUOT') return new JobError('disk_full', 'The quota is used up', detail)
  if (code == 'ENOSPC') {
    const free = await freeSpace(ctx.folder)
    return free !== undefined && free > (size ?? 0) + FULL_MARGIN
      ? undefined
      : new JobError('disk_full', 'The disk is full', detail)
  }
  if (FOLDER_GONE_CODES.has(code) && !(await reachable(ctx.data_dir, ctx.reach_timeout_ms ?? 5000, ctx.signal))) {
    return new JobError('folder_unreachable', 'The folder cannot be reached', detail)
  }
  if (NOT_WRITABLE_CODES.has(code) && !(await canWrite(ctx.data_dir))) {
    return new JobError('folder_not_writable', 'The folder is read-only', detail)
  }
  return undefined
}

/** A name that could not be placed: the reasons the user can act on stay, the rest is a link error */
function linkFailure(reason: FailureCode): FailureCode {
  return reason == 'in_use' || reason == 'file_too_large' ? reason : 'link_error'
}

/** Can a file be created? (Removing the probe is a courtesy: it is a leftover the next run clears) */
async function canWrite(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.opmd-probe-${randomBytes(4).toString('hex')}.tmp`)
  try {
    await fs.writeFile(probe, '')
  } catch {
    return false
  }
  await unlinkQuiet(probe).catch(() => undefined)
  return true
}

export async function executePlan(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { plan, manifest, progress, activity, failed } = ctx
  const result: ExecuteResult = {
    downloaded: 0,
    linked: 0,
    removed: 0,
    failed: 0,
    conflicts: 0,
    copies: 0,
    bytes: 0,
  }
  const fs_lanes = Math.min(16, Math.max(4, ctx.concurrency * 2))
  let fatal: JobError | undefined

  const fail = (
    name: string,
    token: string,
    reason: FailureCode,
    detail?: string,
    size?: number,
    attempts = 1,
  ): void => {
    failed.set({
      name,
      token,
      size,
      reason,
      detail,
      attempts,
      at: new Date().toISOString(),
    })
    if (reason == 'name_conflict') {
      result.conflicts++
    } else {
      result.failed++
      progress.count('failed')
    }
  }

  const changed = (): void => ctx.onChange?.()

  /** Every error of a worker goes through here: fatal ones end the run (decided once) */
  const handle = async (error: unknown, size?: number): Promise<FailureCode | undefined> => {
    if (error instanceof AbortedError || ctx.signal.aborted) return undefined
    if (fatal) throw fatal
    // The check of the folder ends with a stop (AbortedError): no verdict then
    const end = await fatalError(error, ctx, size).catch(() => undefined)
    if (ctx.signal.aborted) return undefined
    if (fatal) throw fatal
    if (end) {
      fatal = end
      // The other workers' transfers stop now, not when they end
      ctx.fail?.(end)
      throw fatal
    }
    return errorCode(error) == 'ENOSPC' ? 'file_too_large' : failureCode(error)
  }

  /** Before each write: none once the run failed or the folder went to another computer */
  const guard = (): void => {
    if (fatal) throw fatal
    ctx.guard?.()
  }

  /** The manifest now and then, under the same guard */
  const checkpoint = async (): Promise<void> => {
    try {
      guard()
    } catch {
      return
    }
    await manifest.checkpoint().catch(() => undefined)
  }

  // Manifest-only changes: no disk work
  for (const name of plan.drop_entries) manifest.delete(name)
  for (const adoption of plan.adoptions) {
    manifest.set(adoption.name, {
      token: adoption.token,
      size: adoption.size,
      mode: adoption.mode,
      remote_name: adoption.remote_name,
    })
  }
  progress.count('already_present', plan.up_to_date)

  // Conflicts are reported, never touched
  for (const conflict of plan.conflicts) {
    activity.add({
      name: conflict.name,
      token: conflict.token,
      size: conflict.size,
      outcome: 'conflict',
      reason: 'name_conflict',
    })
    fail(
      conflict.name,
      conflict.token,
      'name_conflict',
      undefined,
      conflict.size,
    )
  }
  changed()

  const place = async (target: LinkTask): Promise<'link' | 'copy'> => {
    guard()
    const mode = await placeName({
      folder: ctx.folder,
      data_dir: ctx.data_dir,
      name: target.name,
      token: target.token,
      replace: target.replace,
      capability: ctx.capability,
    })
    if (mode == 'copy') result.copies++
    manifest.set(target.name, {
      token: target.token,
      size: target.size,
      mode,
      remote_name: target.remote_name,
    })
    failed.delete(target.name)
    return mode
  }

  try {
    // Links or copies, decided once for the whole job
    if (
      ctx.capability.hardlinks === undefined &&
      (plan.links.length || plan.downloads.length)
    ) {
      ctx.capability.hardlinks = await probeHardLinks(ctx.data_dir)
      if (ctx.capability.hardlinks === false)
        ctx.log?.('info', 'The folder does not take hard links: names are copies')
    }

    // 1. Case changes
    ctx.onStage?.('links')
    await runQueue(
      plan.renames,
      fs_lanes,
      async task => {
        try {
          guard()
          await renameName(ctx.folder, task.from, task.to)
          manifest.set(task.to, task.entry)
          result.linked++
          progress.count('linked')
          activity.add({
            name: task.to,
            token: task.token,
            size: task.entry.size,
            outcome: 'linked',
            same_as: task.from,
          })
        } catch (error) {
          const reason = await handle(error, task.entry.size)
          if (reason)
            fail(
              task.to,
              task.token,
              linkFailure(reason),
              errorDetail(error),
              task.entry.size,
            )
        }
        await checkpoint()
        changed()
      },
      ctx.signal,
    )

    // 2. Names of contents already in data/
    await runQueue(
      plan.links,
      fs_lanes,
      async task => {
        try {
          await place(task)
          result.linked++
          progress.count('linked')
          activity.add({
            name: task.name,
            token: task.token,
            size: task.size,
            outcome: 'linked',
          })
        } catch (error) {
          if (error instanceof ConflictError) {
            activity.add({
              name: task.name,
              token: task.token,
              size: task.size,
              outcome: 'conflict',
              reason: 'name_conflict',
            })
            fail(task.name, task.token, 'name_conflict', undefined, task.size)
          } else {
            const reason = await handle(error, task.size)
            if (reason) {
              const code = linkFailure(reason)
              activity.add({
                name: task.name,
                token: task.token,
                size: task.size,
                outcome: 'failed',
                reason: code,
              })
              fail(task.name, task.token, code, errorDetail(error), task.size)
            }
          }
        }
        await checkpoint()
        changed()
      },
      ctx.signal,
    )

    // 3. Downloads
    if (plan.downloads.length) ctx.onStage?.('downloads')
    await runQueue(
      plan.downloads,
      Math.max(1, ctx.concurrency),
      task => download(task),
      ctx.signal,
    )

    // 4. Removals
    if (!ctx.signal.aborted) {
      if (plan.remove_names.length || plan.remove_tokens.length)
        ctx.onStage?.('removals')
      await runQueue(
        plan.remove_names,
        fs_lanes,
        async name => {
          const entry = manifest.get(name)
          try {
            guard()
            await removeName(ctx.folder, name)
            manifest.delete(name)
            result.removed++
            progress.count('removed')
            activity.add({
              name,
              token: entry?.token,
              size: entry?.size,
              outcome: 'removed',
            })
          } catch (error) {
            // Not removed: it stays in the manifest and the next run tries again
            const reason = await handle(error, entry?.size)
            if (reason) {
              activity.add({
                name,
                token: entry?.token,
                size: entry?.size,
                outcome: 'failed',
                reason: reason == 'in_use' ? reason : 'write_error',
              })
              ctx.log?.('warn', `Cannot remove ${name}: ${errorDetail(error)}`)
            }
          }
          await checkpoint()
          changed()
        },
        ctx.signal,
      )
      await runQueue(
        plan.remove_tokens,
        fs_lanes,
        async token => {
          try {
            guard()
            await removeName(ctx.data_dir, token)
          } catch (error) {
            const reason = await handle(error)
            if (reason)
              ctx.log?.(
                'warn',
                `Cannot remove data/${token}: ${errorDetail(error)}`,
              )
          }
        },
        ctx.signal,
      )
    }
  } catch (error) {
    if (fatal) throw fatal
    throw error
  }
  return result

  async function download(task: DownloadTask): Promise<void> {
    guard()
    const first = task.names[0]
    const entry = activity.add({
      name: first.name,
      token: task.token,
      size: task.size,
      outcome: 'downloading',
      progress: 0,
    })
    progress.progress.in_flight++
    changed()
    let attempt_bytes = 0
    let attempts = 0
    let known_size = task.size
    try {
      await withRetry(
        ctx.policy ?? DOWNLOAD_RETRY,
        {
          signal: ctx.signal,
          onRetry: (error, attempt, delay) => {
            progress.addBytes(-attempt_bytes)
            attempt_bytes = 0
            activity.update(entry.id, { progress: 0 })
            if (error instanceof HttpError && error.status == 429)
              ctx.onRateLimited?.(delay)
            ctx.log?.(
              'debug',
              `Retry ${attempt} for ${task.token} in ${delay} ms: ${errorDetail(
                error,
              )}`,
            )
            changed()
          },
        },
        async () => {
          attempts++
          const bytes = await downloadToFile({
            fetch: ctx.fetch,
            url: ctx.storageUrl(task.token, first.remote_name),
            target: path.join(ctx.data_dir, task.token),
            expected_size: task.size,
            signal: ctx.signal,
            headers_timeout_ms: ctx.headers_timeout_ms,
            idle_timeout_ms: ctx.idle_timeout_ms,
            onLength: length => {
              if (known_size === undefined) {
                known_size = length
                progress.addBytesTotal(length)
              }
            },
            onBytes: delta => {
              attempt_bytes += delta
              progress.addBytes(delta)
              if (known_size)
                activity.update(entry.id, {
                  progress: Math.min(1, attempt_bytes / known_size),
                })
            },
          })
          result.bytes += bytes
        },
      )
    } catch (error) {
      progress.addBytes(-attempt_bytes)
      progress.progress.in_flight--
      if (error instanceof AbortedError || ctx.signal.aborted) {
        activity.update(entry.id, {
          outcome: 'failed',
          reason: 'aborted',
          progress: undefined,
        })
        changed()
        return
      }
      const reason = await handle(error, task.size)
      if (!reason) return
      activity.update(entry.id, {
        outcome: 'failed',
        reason,
        progress: undefined,
      })
      for (const target of task.names)
        fail(
          target.name,
          task.token,
          reason,
          errorDetail(error),
          task.size,
          attempts,
        )
      changed()
      return
    }
    progress.progress.in_flight--

    // The content is in data/: put it under every name
    let placed_first = false
    let stopped = false
    for (const target of task.names) {
      try {
        await place({ ...target, token: task.token })
        result.downloaded++
        progress.count('downloaded')
        if (!placed_first) {
          placed_first = true
          activity.update(entry.id, {
            outcome: 'downloaded',
            progress: undefined,
            name: target.name,
          })
        } else {
          activity.add({
            name: target.name,
            token: task.token,
            size: task.size,
            outcome: 'linked',
            same_as: first.name,
          })
        }
      } catch (error) {
        if (error instanceof ConflictError) {
          activity.add({
            name: target.name,
            token: task.token,
            size: task.size,
            outcome: 'conflict',
            reason: 'name_conflict',
          })
          fail(target.name, task.token, 'name_conflict', undefined, task.size)
          continue
        }
        const reason = await handle(error, task.size)
        if (!reason) {
          // Stopped, or the job is over: no more names
          stopped = true
          break
        }
        const code = linkFailure(reason)
        activity.add({
          name: target.name,
          token: task.token,
          size: task.size,
          outcome: 'failed',
          reason: code,
        })
        fail(target.name, task.token, code, errorDetail(error), task.size)
      }
    }
    if (!placed_first)
      activity.update(entry.id, {
        outcome: 'failed',
        reason: stopped ? 'aborted' : 'link_error',
        progress: undefined,
      })
    await checkpoint()
    changed()
  }
}
