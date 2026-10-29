/**
 * Routing of Session operations to an SSH-attached remote Host.
 *
 * The local Session catalog and every Session-addressed method speak one
 * wire contract, so a remote Session is ordinary catalog data with a `host`
 * annotation. This directory owns the only knowledge of which attached Host
 * answers for which Session identity and turns remote failures into the same
 * Remote errors local operations raise.
 * @module @deepseek-ai/dsh-api-session-controller/remote-hosts
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RemoteHostHandle } from '@deepseek-ai/dsh-api-remote-hosts'
import type {} from '@deepseek-ai/dsh-api-gateway'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { SessionHost, SessionListValue, SessionSummary, SessionCreateRequest, SessionCreateValue } from './types.ts'

const createdSession = z.object({
  sessionId: z.string().min(1).transform(SessionId),
  agentPreset: z.string().optional(),
})

/** Attached Hosts and the Session identities each one answers for. */
export class RemoteSessionDirectory {
  private readonly owners = new Map<string, RemoteHostHandle>()

  /**
   * @param ctx - Host context that may carry the optional attachment service.
   */
  constructor(private readonly ctx: Context) {
    ctx.on('api-session/added', (summary) => {
      if (summary.host === undefined) return
      const host = this.hosts().find(candidate => candidate.id === summary.host?.id)
      if (host !== undefined) this.owners.set(summary.sessionId, host)
    })
    ctx.on('api-session/removed', (sessionId) => { this.owners.delete(sessionId) })
    ctx.inject(['typertGateway'], (scope) => {
      scope.effect(() => scope.typertGateway.registerForwarder((resources) => {
        const sessions = resources.flatMap(resource => resource.kind === 'session' ? [resource.id] : [])
        const hosts = sessions.map(id => this.hostOf(id))
        const target = hosts.find(host => host !== undefined)
        if (target === undefined) return undefined
        if (hosts.some(host => host?.id !== target.id)) {
          throw new RemoteError('gateway/bad-request', 'A request cannot span Sessions on different Hosts', {})
        }
        return target
      }), 'session-controller: remote resource routing')
    })
  }

  /**
   * Attached Hosts in configuration order.
   * @returns one handle per usable attachment.
   */
  hosts(): readonly RemoteHostHandle[] {
    return this.ctx.get('remoteHosts')?.connected() ?? []
  }

  /**
   * Create remotely and register routing before the browser can follow the result.
   * @param request - Creation fields including the selected Host.
   * @returns Created identity and its Host annotation.
   */
  async create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    const { hostId, ...remoteRequest } = request
    const host = this.hosts().find(candidate => candidate.id === hostId)
    if (host === undefined) throw new RemoteError('remote-hosts/not-connected', `The selected Host ${hostId} is not connected`, { id: hostId ?? '' })
    const value = createdSession.parse(await this.invoke<unknown>(host, 'session/create', remoteRequest))
    this.owners.set(value.sessionId, host)
    return { sessionId: value.sessionId, host: { id: host.id, name: host.name },
      ...(value.agentPreset === undefined ? {} : { agentPreset: value.agentPreset }),
    }
  }

  /**
   * Merge attached Hosts' catalogs into one local list result.
   *
   * A Host that fails to answer contributes no rows instead of failing the
   * whole catalog: the user still sees local Sessions and every other Host.
   * A row whose identity a local Session already uses stays local.
   * @param local - locally visible rows.
   * @param signal - list cancellation.
   * @returns local rows followed by each attached Host's rows.
   */
  async merge(local: readonly SessionSummary[], signal?: AbortSignal): Promise<SessionSummary[]> {
    const hosts = this.hosts()
    if (hosts.length === 0) return [...local]
    const localIds = new Set(local.map(summary => summary.sessionId))
    for (const id of localIds) this.owners.delete(id)
    const groups = await Promise.all(hosts.map(async (host) => {
      try {
        // The remote descriptor names its only request parameter `_request`.
        const value = await host.invoke('session/list', { _request: {} }, signal) as SessionListValue
        if (!Array.isArray(value.items)) return []
        const hostLabel: SessionHost = { id: host.id, name: host.name }
        const rows = value.items
          .filter((summary: SessionSummary) => !localIds.has(summary.sessionId))
          .map((summary: SessionSummary) => ({ ...summary, host: hostLabel }))
        for (const row of rows) this.owners.set(row.sessionId, host)
        return rows
      } catch (error: unknown) {
        // One unreachable Host must not hide every other catalog.
        console.warn(`remote-hosts: could not list Sessions on ${host.name}: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    }))
    return [...local, ...groups.flat()]
  }

  /**
   * Resolve the attached Host that answers for one Session.
   * @param sessionId - Session identity.
   * @returns its Host, or undefined for a locally hosted Session.
   */
  hostOf(sessionId: SessionId): RemoteHostHandle | undefined {
    const owner = this.owners.get(sessionId)
    if (owner === undefined) return undefined
    const host = this.hosts().find(candidate => candidate.id === owner.id)
    if (host === undefined) throw new RemoteError('remote-hosts/not-connected', `Host ${owner.name} is disconnected; reconnect to continue`, { id: owner.id })
    return host
  }

  /**
   * Invoke one Session method on an attached Host.
   * @param host - the Host that owns the Session.
   * @param endpoint - canonical `session/*` endpoint.
   * @param request - the local request, carried as the remote method's `request` argument.
   * @param signal - caller cancellation.
   * @returns the remote successful value.
   * @throws RemoteError when the remote Host refuses the call or its transport fails.
   */
  async invoke<T>(host: RemoteHostHandle, endpoint: string, request: object, signal?: AbortSignal): Promise<T> {
    return await host.invoke(endpoint, { request }, signal) as T
  }

  /**
   * Open one Session stream on an attached Host.
   * @param host - the Host that owns the Session.
   * @param endpoint - canonical `session/*` stream endpoint.
   * @param request - the local request, carried as the remote method's `request` argument.
   * @param signal - stream cancellation.
   * @returns the remote downlink values.
   */
  stream<T>(host: RemoteHostHandle, endpoint: string, request: object, signal?: AbortSignal): AsyncIterable<T> {
    // Stream payloads carry the same named arguments under `args`.
    return host.stream(endpoint, { args: { request } }, signal) as AsyncIterable<T>
  }
}
