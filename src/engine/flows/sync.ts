/**
 * «Sincronizza»: list (incremental when possible), compare; when nothing
 * needs downloading, the links and the removals within the threshold are
 * applied at once and the job ends as a completed sync.
 */
import { SyncResult } from '../../shared/models'
import { JobContext } from '../job'
import { bookkeeping, summaryAfter } from '../plan'
import { compare, execute, inFolder, list, resultOf, stopped } from './steps'

export function runSync(ctx: JobContext, full: boolean): Promise<SyncResult> {
  return inFolder(ctx, async session => {
    const listed = await list(ctx, { full, reuse: false })
    const plan = await compare(ctx, session, listed)
    if (plan.downloads.length) {
      // Only bookkeeping now (adoptions, forgotten names); the rest waits for «Scarica»
      await execute(ctx, session, bookkeeping(plan), false)
      return resultOf(ctx, 'completed')
    }
    const executed = await execute(ctx, session, plan, true)
    if (ctx.job.stopped) return stopped(ctx, plan, session, executed)
    ctx.slot.state.setPlan(summaryAfter(plan, executed))
    return resultOf(ctx, 'completed')
  })
}
