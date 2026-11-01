/**
 * «Conferma» of the removals above the threshold. The confirmation covers
 * the names the plan held back when the user saw it, and lasts this job
 * only: those names go now (downloads and links, when there are some, wait
 * for «Scarica»); a removal outside them waits again above the threshold.
 */
import { SyncResult } from '../../shared/models'
import { JobContext } from '../job'
import { removalsOnly, summaryAfter, summaryLeft } from '../plan'
import { compare, execute, inFolder, list, resultOf, stopped } from './steps'

export function runCleanup(ctx: JobContext, confirmed: ReadonlySet<string>): Promise<SyncResult> {
  return inFolder(ctx, async session => {
    const listed = await list(ctx, { full: false, reuse: true })
    const plan = await compare(ctx, session, listed, confirmed)
    // Nothing to download: everything goes now, as a «Sincronizza» would do
    const whole = !plan.downloads.length
    const executed = await execute(ctx, session, whole ? plan : removalsOnly(plan), whole)
    if (ctx.job.stopped) return stopped(ctx, plan, session, executed)
    ctx.slot.state.setPlan(
      whole ? summaryAfter(plan, executed) : summaryLeft(plan, session.manifest, executed.conflicts),
    )
    return resultOf(ctx, 'completed')
  })
}
