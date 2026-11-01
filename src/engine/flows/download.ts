/**
 * «Scarica» and «Riprova i falliti»: the listing of the last «Sincronizza»
 * when it is fresh (a new one otherwise), a new compare, then the whole plan,
 * or only the names that failed.
 */
import { SyncResult } from '../../shared/models'
import { JobContext } from '../job'
import { onlyNames, summaryAfter, summaryLeft } from '../plan'
import { compare, execute, inFolder, list, resultOf, stopped } from './steps'

export function runDownload(ctx: JobContext, only_failed: boolean): Promise<SyncResult> {
  const retry = only_failed ? new Set(ctx.slot.failed.retryable().map(e => e.name)) : undefined
  return inFolder(ctx, async session => {
    const listed = await list(ctx, { full: false, reuse: true })
    const plan = await compare(ctx, session, listed)
    const part = retry ? onlyNames(plan, retry) : plan
    await session.checkRoom(part, ctx.slot.state.copies)
    const executed = await execute(ctx, session, part, !retry)
    if (ctx.job.stopped) return stopped(ctx, plan, session, executed)
    ctx.slot.state.setPlan(
      retry
        ? // Other work may still be pending: the rest of the plan says what
          summaryLeft(plan, session.manifest, executed.conflicts)
        : summaryAfter(plan, executed),
    )
    return resultOf(ctx, 'completed')
  })
}
