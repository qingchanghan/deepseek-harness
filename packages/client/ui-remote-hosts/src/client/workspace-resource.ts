/** Shared picker and sidebar Workspace stream, cancelled when its last consumer releases it. */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteHostWorkspaces, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Workspaces listed by the Host named in the address path. */
    'remote-workspaces': RemoteHostWorkspaces
  }
}

/**
 * Register live Workspace membership through the common resource owner.
 * @param ctx - Client context with resources and generated Remotes.
 */
export function registerWorkspaceResource(ctx: Context): void {
  ctx.effect(() => ctx.resources.register<'remote-workspaces'>({
    protocol: 'remote-workspaces',
    async *open(address, { signal }): AsyncIterable<RemoteResult<RemoteHostWorkspaces>> {
      const id = decodeURIComponent(new URL(address).pathname.slice(1))
      try {
        for await (const value of ctx.remote.remoteHosts.followWorkspaces(id, signal)) yield { ok: true, value }
      } catch (error) {
        if (signal.aborted) return
        yield { ok: false, error: Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), {
          name: 'RemoteError', isDSHRemoteError: true as const, code: 'gateway/internal' as const, details: {},
        }) }
      }
    },
  }), 'ui-remote-hosts: Workspace resource')
}
