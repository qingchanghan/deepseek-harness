/** Read metered Sessions for the usage page without attaching Agents or loading transcripts into the client. */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelUsageBucket } from '@deepseek-ai/dsh-token-meter/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'

interface UsageReport {
  rows: readonly ModelUsageBucket[]
  missingSessions: number
  unavailableHosts: number
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Exact available Session usage from the local Host and its SSH connections. */
    'usage-report': UsageReport
  }
}

const READ_CONCURRENCY = 4

/**
 * Mount the usage page resource. In-flight cold projection requests share its cancellation.
 * @param ctx - scoped resource and model usage services.
 * @returns disposer for the registered resource.
 */
export function registerUsageReport(ctx: Context): () => void {
  return ctx.resources.register<'usage-report'>({
    protocol: 'usage-report',
    async *open(_address, { signal }) {
      const aborted = () => signal.aborted
      const [sessions, hosts] = await Promise.all([
        ctx.remote.session.list({}, signal),
        ctx.remote.remoteHosts.describe(),
      ])
      if (aborted()) return
      if (!sessions.ok) {
        yield sessions
        return
      }
      if (!hosts.ok && hosts.error.code !== 'gateway/service-unavailable' && hosts.error.code !== 'gateway/definition-unavailable') {
        yield hosts
        return
      }
      const rows: ModelUsageBucket[] = []
      let missingSessions = 0
      for (let index = 0; index < sessions.value.items.length; index += READ_CONCURRENCY) {
        if (aborted()) return
        const batch = sessions.value.items.slice(index, index + READ_CONCURRENCY)
        const samples = await Promise.all(batch.map(async (session) => {
          const hints = session.projections
          if (hints?.kind === 'sequenced' && hints.values.modelUsage !== undefined) return hints.values.modelUsage
          const result = await ctx.remote.session.projections({ sessionId: session.sessionId }, signal)
          return result.ok && result.value?.kind === 'sequenced' ? result.value.values.modelUsage : undefined
        }))
        for (const sample of samples) {
          if (sample === undefined) missingSessions++
          else for (const row of sample) rows.push(row)
        }
      }
      if (aborted()) return
      yield {
        ok: true,
        value: {
          rows,
          missingSessions,
          unavailableHosts: hosts.ok ? hosts.value.hosts.filter(host => host.status !== 'connected').length : 0,
        },
      }
    },
  })
}
