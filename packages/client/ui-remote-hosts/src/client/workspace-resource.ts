/** Remote Workspace resource: each picker read belongs to one Host and aborts on release. */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteHostWorkspace, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Workspaces listed by the Host named in the address path. */
    'remote-workspaces': { items: RemoteHostWorkspace[] }
  }
}

/**
 * Register cancellable Workspace reads through the common resource owner.
 * @param ctx - Client context with resources and generated Remotes.
 */
export function registerWorkspaceResource(ctx: Context): void {
  ctx.effect(() => ctx.resources.register<'remote-workspaces'>({
    protocol: 'remote-workspaces',
    async *open(address, { signal }): AsyncIterable<RemoteResult<{ items: RemoteHostWorkspace[] }>> {
      const id = decodeURIComponent(new URL(address).pathname.slice(1))
      try {
        yield await ctx.remote.remoteHosts.workspaces(id, signal)
      } catch (error) {
        if (signal.aborted) return
        yield { ok: false, error: Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), {
          name: 'RemoteError', isDSHRemoteError: true as const, code: 'gateway/internal' as const, details: {},
        }) }
      }
    },
  }), 'ui-remote-hosts: Workspace resource')
}
