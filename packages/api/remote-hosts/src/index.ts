/**
 * SSH-attached remote dsh Hosts for the Web surface.
 *
 * One configured OpenSSH destination is one remote Harness machine. Attaching
 * means: read the instance descriptor the remote `dsh web` published, forward
 * one loopback port to its listener, authenticate with its launch token, and
 * keep a multiplexed Remote connection open. Session catalog merging, method
 * routing, and presentation belong to their owners; this service supplies the
 * transport handles and republishes the remote session events those owners
 * already forward to browsers.
 * @module @deepseek-ai/dsh-api-remote-hosts
 */

import { type Context, type Volatile } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Generated Remote descriptors validate wire values with Zod.
import type {} from 'zod'
import type { ForwardedRemoteEvent } from '@deepseek-ai/dsh-api-gateway/types'
import z from '@deepseek-ai/schemastery'
import { RemoteHostClient, RemoteHostFailure } from './remote-client.ts'
import { listRemoteInstances, newestInstance, openTunnel, type SshTarget, type Tunnel } from './ssh.ts'
import type { RemoteHostEntry, RemoteHostStatus, RemoteHostsSnapshot, RemoteHostsUpdate, RemoteHostWorkspace } from './types.ts'
import { readWorkspaces, addWorkspace } from './workspaces.ts'

export type * from './types.ts'
export { RemoteHostFailure } from './remote-client.ts'
export type { RemoteClientOptions } from './remote-client.ts'
export type { SshTarget, Tunnel } from './ssh.ts'

/** Max characters of one recorded attachment failure. */
const MAX_ERROR_LENGTH = 500

/** Forwarded waterfalls a local browser can answer on a remote Agent's behalf. */
const INTERACTIVE_EVENTS = new Set(['approval/request', 'user-questions/request'])

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** SSH-attached remote Hosts; absent when the composition omits this row. */
    remoteHosts: RemoteHosts
  }

}

/** Remote Hosts deployment configuration. */
export interface Config {
  /** SSH development machines this Host may attach to. */
  readonly hosts: Volatile<RemoteHostEntry[]>
  /** Deadline for one SSH command, HTTP request, or handshake, in milliseconds. */
  readonly timeoutMs: number
  /** Attach every configured host while this plugin activates. */
  readonly connectOnStart: boolean
  /** First delay before retrying a failed attachment, in milliseconds. */
  readonly retryDelayMs: number
  /** Upper bound for the doubled retry delay, in milliseconds. */
  readonly maxRetryDelayMs: number
}

/** A configured host that currently has a usable Remote connection. */
export interface RemoteHostHandle {
  /** Stable identity. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /**
   * Invoke one Remote method on the remote Host.
   * @param endpoint - canonical `namespace/method` endpoint.
   * @param args - named arguments of that method.
   * @param signal - caller cancellation.
   * @returns the successful value.
   */
  invoke(endpoint: string, args: object, signal?: AbortSignal): Promise<unknown>
  /**
   * Open one logical Remote stream on the remote Host.
   * @param endpoint - canonical endpoint.
   * @param payload - complete stream payload.
   * @param signal - stream cancellation.
   * @returns the stream's downlink values.
   */
  stream(endpoint: string, payload: unknown, signal?: AbortSignal): AsyncIterable<unknown>
}

interface HostState {
  readonly entry: RemoteHostEntry
  readonly name: string
  status: RemoteHostStatus['status']
  error: string | undefined
  pid: number | undefined
  tunnel: Tunnel | undefined
  client: RemoteHostClient | undefined
  abort: AbortController | undefined
  retry: NodeJS.Timeout | undefined
  attempts: number
  paused: boolean
  task: Promise<void> | undefined
  events: Promise<void> | undefined
}

/** SSH-attached remote Host transport owner. */
export default class RemoteHosts extends TypertRemoteService {
  static inject: string[] = []

  static Config = z.object({
    hosts: z.array(z.object({
      id: z.string().min(1).pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
      name: z.string().min(1).required(false),
      sshTarget: z.string().min(1).pattern(/^[^\s-][^\s]*$/u),
      sshPort: z.natural().min(1).max(65535).required(false),
      remoteHome: z.string().min(1).required(false),
    })).default([]).volatile(),
    timeoutMs: z.natural().min(1).default(30_000),
    connectOnStart: z.boolean().default(true),
    retryDelayMs: z.natural().min(1).default(5_000),
    maxRetryDelayMs: z.natural().min(1).default(60_000),
  })

  private readonly ownerContext: Context
  private readonly states = new Map<string, HostState>()
  private reconciliation: Promise<void> = Promise.resolve()
  private readonly waterfalls = new Map<string, { hostId: string; pending: ForwardedRemoteEvent }>()

  /**
   * @param ctx - Host context.
   * @param config - configured destinations and attachment policy.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'remoteHosts')
    this.ownerContext = ctx
    for (const entry of config.hosts.get()) {
      if (this.states.has(entry.id)) throw new Error(`remote-hosts: duplicate host id ${JSON.stringify(entry.id)}`)
      this.states.set(entry.id, createHostState(entry))
    }
    ctx.on('loader/volatile-update', () => {
      const entries = this.config.hosts.get()
      const operation = this.reconciliation.then(() => this.reconcile(entries), () => this.reconcile(entries))
      this.reconciliation = operation
      void operation.catch((error: unknown) => {
        for (const state of this.states.values()) this.fail(state, error)
      })
    })
    this.timeoutMs = config.timeoutMs
    this.retryDelayMs = config.retryDelayMs
    this.maxRetryDelayMs = config.maxRetryDelayMs
    if (config.connectOnStart) {
      ctx.effect(() => {
        for (const state of this.states.values()) void this.startAttach(state)
        return async () => { await this.detachAll() }
      }, 'remote-hosts: attachment lifecycle')
    } else {
      ctx.effect(() => async () => { await this.detachAll() }, 'remote-hosts: attachment lifecycle')
    }
  }

  private readonly timeoutMs: number
  private readonly retryDelayMs: number
  private readonly maxRetryDelayMs: number
  private disposed = false

  /**
   * Every configured host and its attachment lifecycle.
   * @returns stable-order status rows.
   */
  list(): RemoteHostStatus[] {
    return [...this.states.values()].map(state => ({
      ...state.entry,
      name: state.name,
      status: state.status,
      ...(state.error === undefined ? {} : { error: state.error }),
      ...(state.pid === undefined ? {} : { pid: state.pid }),
    }))
  }

  /**
   * Read connection settings and current states, including empty remote hosts.
   * @returns Current host rows and the revision needed for persistent edits.
   */
  @Remote
  describe(): RemoteHostsSnapshot {
    const entryId = this.ownerContext.fiber.entry?.options.id
    const settings = this.ownerContext.get('settings')
    const descriptor = settings?.describe({ redactSecrets: true }).find(row => row.ns === entryId)
    return { hosts: this.list(), writable: descriptor !== undefined, revision: descriptor?.revision ?? 0 }
  }

  /**
   * Persist a revision-checked connection list and start newly configured connections.
   * A connection failure keeps its configuration and is reported in its host row.
   * @param request - Complete connection list and its last observed revision.
   * @returns Persisted connection settings and current attachment states.
   * @throws {RemoteError} `remote-hosts/configuration-rejected` when validation or persistence fails;
   * `remote-hosts/conflict` when another edit changed the configuration revision.
   */
  @Remote
  async setHosts(request: RemoteHostsUpdate): Promise<RemoteHostsSnapshot> {
    try {
      const entries = RemoteHosts.Config({ hosts: request.hosts }).hosts.get()
      if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Connection identifiers must be unique')
      const entryId = this.ownerContext.fiber.entry?.options.id
      const settings = this.ownerContext.get('settings')
      if (entryId === undefined || settings === undefined) throw new Error('This profile does not support saving connections')
      await settings.update(entryId, { hosts: entries }, request.expectedRevision)
      await this.reconciliation
      return this.describe()
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'SETTINGS_CONFLICT') {
        throw new RemoteError('remote-hosts/conflict', 'Connection settings changed while the editor was open', {
          expected: request.expectedRevision, actual: this.describe().revision,
        }, { cause: error })
      }
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('remote-hosts/configuration-rejected', reason, { reason }, { cause: error })
    }
  }

  /**
   * Retry one configured connection immediately.
   * @param id - Configured host identity.
   * @returns Current connection settings and attachment states.
   * @throws {RemoteError} `remote-hosts/not-found` when the host was removed.
   */
  @Remote
  async reconnect(id: string): Promise<RemoteHostsSnapshot> {
    await this.connect(id)
    return this.describe()
  }

  /**
   * Stop a connection and its automatic retries without deleting its settings.
   * @param id - Configured host identity.
   * @returns Current connection settings and attachment states.
   * @throws {RemoteError} `remote-hosts/not-found` when the host was removed.
   */
  @Remote
  async disconnectHost(id: string): Promise<RemoteHostsSnapshot> {
    await this.disconnect(id)
    return this.describe()
  }

  /**
   * Attached hosts, in configuration order.
   * @returns one handle per usable Remote connection.
   */
  connected(): readonly RemoteHostHandle[] {
    return [...this.states.values()].flatMap((state) => {
      const client = state.client
      if (state.status !== 'connected' || client === undefined) return []
      return [{
        id: state.entry.id,
        name: state.name,
        invoke: (endpoint: string, args: object, signal?: AbortSignal) =>
          client.invoke(endpoint, args, signal),
        stream: (endpoint: string, payload: unknown, signal?: AbortSignal) =>
          client.stream(endpoint, payload, signal),
      } satisfies RemoteHostHandle]
    })
  }

  /**
   * Resolve a usable connection without silently selecting another Host.
   * @param id - Configured Host identity.
   * @returns Current connection handle.
   */
  connection(id: string): RemoteHostHandle {
    this.require(id)
    const host = this.connected().find(candidate => candidate.id === id)
    if (host === undefined) throw new RemoteError('remote-hosts/not-connected', `Connect ${id} before selecting a Workspace`, { id })
    return host
  }

  /**
   * Read the selected Host's Workspaces, closing the baseline stream afterwards.
   * @param id - Configured Host identity.
   * @param signal - Cancel a superseded picker read.
   * @returns Remote Workspaces in their saved order.
   */
  @Remote
  workspaces(id: string, signal: AbortSignal): Promise<{ items: RemoteHostWorkspace[] }> {
    return readWorkspaces(this.connection(id), AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]))
  }

  /**
   * Add an existing directory to the selected Host's Workspace registry.
   * @param id - Configured Host identity.
   * @param path - Absolute directory on that Host.
   * @returns The remote Workspace.
   */
  @Remote
  createWorkspace(id: string, path: string): Promise<RemoteHostWorkspace> {
    return addWorkspace(this.connection(id), path)
  }

  /**
   * Attach one configured host, republishing a previous failure.
   * @param id - configured host identity.
   * @param signal - caller cancellation.
   */
  async connect(id: string, signal?: AbortSignal): Promise<void> {
    const state = this.require(id)
    this.clearRetry(state)
    state.attempts = 0
    await this.stop(state)
    state.paused = false
    await this.startAttach(state, signal)
  }

  /**
   * Detach one configured host, keeping its configuration.
   * @param id - configured host identity.
   */
  async disconnect(id: string): Promise<void> {
    const state = this.require(id)
    this.clearRetry(state)
    await this.stop(state)
  }

  private require(id: string): HostState {
    const state = this.states.get(id)
    if (state === undefined) throw new RemoteError('remote-hosts/not-found', `Connection ${id} no longer exists`, { id })
    return state
  }

  private async reconcile(entries: readonly RemoteHostEntry[]): Promise<void> {
    if (this.disposed) return
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Connection identifiers must be unique')
    for (const [id, state] of this.states) {
      const next = entries.find(entry => entry.id === id)
      if (JSON.stringify(next) === JSON.stringify(state.entry)) continue
      await this.stop(state)
      this.states.delete(id)
    }
    for (const entry of entries) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Disposal can run while stop awaits transport cleanup.
      if (this.states.has(entry.id) || this.disposed) continue
      const state = createHostState(entry)
      this.states.set(entry.id, state)
      void this.startAttach(state)
    }
    this.ownerContext.emit('remote-hosts/changed')
  }

  private startAttach(state: HostState, signal?: AbortSignal): Promise<void> {
    if (state.task !== undefined) return state.task
    if (this.disposed || state.paused) return Promise.resolve()
    const task = this.attach(state, signal).catch((error: unknown) => {
      if (!this.disposed) this.fail(state, error)
    })
    state.task = task
    void task.then(() => { if (state.task === task) state.task = undefined })
    return task
  }

  private async stop(state: HostState): Promise<void> {
    state.paused = true
    this.clearRetry(state)
    state.abort?.abort()
    await state.task
    await this.detach(state)
  }

  private async attach(state: HostState, signal: AbortSignal | undefined): Promise<void> {
    if (state.status === 'connected' || state.status === 'connecting') return
    await this.detach(state)
    if (state.paused || this.disposed) return
    this.setState(state, 'connecting')
    const abort = new AbortController()
    state.abort = abort
    const target = this.targetOf(state)
    try {
      const instances = await listRemoteInstances(target, abort.signal)
      abort.signal.throwIfAborted()
      const instance = newestInstance(instances)
      if (instance === undefined) {
        throw new Error('no running dsh Web instance was published below the remote Harness home; start dsh web there first')
      }
      if (instance.protocol !== 'http:') {
        throw new Error(`the published instance serves ${instance.protocol}; remote attachment currently requires plain HTTP on the remote loopback listener`)
      }
      const token = new URL(instance.url).searchParams.get('token')
      if (token === null || token === '') {
        throw new Error('the published instance URL carries no launch token; start dsh web with instance announcement enabled')
      }
      const tunnel = await openTunnel(target, { host: instance.host, port: instance.port })
      state.tunnel = tunnel
      abort.signal.throwIfAborted()
      const client = new RemoteHostClient({
        baseUrl: `http://127.0.0.1:${String(tunnel.port)}`,
        token,
        timeoutMs: this.timeoutMs,
      })
      state.client = client
      state.pid = instance.pid
      state.attempts = 0
      await client.invoke('session/list', { _request: {} }, abort.signal)
      abort.signal.throwIfAborted()
      this.setState(state, 'connected')
      state.events = this.followEvents(state, client, abort.signal)
      signal?.throwIfAborted()
    } catch (error: unknown) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Disposal can overtake the awaited SSH or HTTP operation.
      const cancelled = abort.signal.aborted || state.paused || this.disposed
      await this.detach(state)
      if (cancelled) return
      this.fail(state, error)
      this.scheduleRetry(state)
    }
  }

  /**
   * Retry one failed attachment with doubling delay.
   *
   * A development machine can start `dsh web` after this Host booted, so a
   * failed first attempt is not terminal; the retry stops when the plugin
   * unloads or the operator disconnects the host.
   * @param state - host whose attachment failed.
   */
  private scheduleRetry(state: HostState): void {
    if (this.disposed || state.paused || !this.states.has(state.entry.id) || state.retry !== undefined) return
    const delay = Math.min(this.retryDelayMs * 2 ** state.attempts, this.maxRetryDelayMs)
    state.attempts += 1
    state.retry = setTimeout(() => {
      state.retry = undefined
      if (this.disposed) return
      void this.startAttach(state)
    }, delay)
    state.retry.unref()
  }

  /**
   * Forget one host's pending retry.
   * @param state - host to stop retrying.
   */
  private clearRetry(state: HostState): void {
    if (state.retry === undefined) return
    clearTimeout(state.retry)
    state.retry = undefined
  }

  /**
   * Republish the remote Host's forwarded session events locally.
   *
   * The local forwarding source and the browser already understand these
   * events, so replaying them here keeps a remote session's running state and
   * title as fresh as a local one. Waterfall requests are delegated back to the
   * remote chain instead of answered, because the browser's answerer belongs
   * to the local Host.
   * @param state - attached host state.
   * @param client - its Remote connection.
   * @param signal - attachment lifetime.
   */
  private async followEvents(state: HostState, client: RemoteHostClient, signal: AbortSignal): Promise<void> {
    let clientId: string | undefined
    try {
      for await (const value of client.stream('$events', { args: {} }, signal)) {
        if (!isRecord(value)) continue
        if (value['type'] === 'ready' && typeof value['clientId'] === 'string') {
          clientId = value['clientId']
          continue
        }
        if (value['type'] === 'emit' && typeof value['event'] === 'string' && value['event'].startsWith('api-session/')) {
          this.republish(state, value['event'], Array.isArray(value['args']) ? value['args'] : [])
          continue
        }
        if (value['type'] === 'waterfall' && clientId !== undefined && typeof value['eventId'] === 'string') {
          this.forwardWaterfall(state, client, clientId, value)
          continue
        }
        if (value['type'] === 'cancel' && typeof value['eventId'] === 'string') {
          const pending = this.waterfalls.get(value['eventId'])
          if (pending !== undefined) {
            pending.pending.cancel(new Error('The remote Host withdrew the request'))
            this.waterfalls.delete(value['eventId'])
          }
        }
      }
    } catch (error: unknown) {
      if (signal.aborted) return
      this.fail(state, error)
      this.scheduleRetry(state)
    }
  }

  /**
   * Ask the local browser to answer one remote interactive waterfall.
   *
   * Only approval and question requests cross Hosts: their answers are plain
   * JSON decisions the local UI already produces. Every other waterfall (and
   * any request when the local assembly has no bridge) delegates to the remote
   * chain.
   * @param state - the Host that delivered the request.
   * @param client - the attached Host connection.
   * @param clientId - remote event-stream generation identity.
   * @param frame - the remote waterfall frame.
   */
  private forwardWaterfall(state: HostState, client: RemoteHostClient, clientId: string, frame: Record<string, unknown>): void {
    const event = frame['event']
    const eventId = frame['eventId']
    const agentId = frame['agentId']
    const request = frame['request']
    if (typeof eventId !== 'string') return
    const bridge = this.ownerContext.get('remoteEventBridge')
    if (bridge === undefined || typeof event !== 'string' || typeof agentId !== 'string'
      || !isRecord(request) || !INTERACTIVE_EVENTS.has(event)) {
      void this.answerRemoteEvent(client, clientId, eventId, { kind: 'next' })
      return
    }
    const pending = bridge.forward(event, agentId, request)
    this.waterfalls.set(eventId, { hostId: state.entry.id, pending })
    void pending.outcome
      .then(async outcome => this.answerRemoteEvent(client, clientId, eventId, outcome))
      .finally(() => { this.waterfalls.delete(eventId) })
  }

  /**
   * Return one waterfall outcome to the attached Host.
   * @param client - the attached Host connection.
   * @param clientId - remote event-stream generation identity.
   * @param eventId - remote waterfall identity.
   * @param outcome - browser answer or delegation.
   */
  private async answerRemoteEvent(
    client: RemoteHostClient,
    clientId: string,
    eventId: string,
    outcome: { readonly kind: 'result'; readonly value?: unknown } | { readonly kind: 'next' },
  ): Promise<void> {
    try {
      await client.invoke('$events/result', { clientId, eventId, outcome })
    } catch {
      // A withdrawn remote event accepts no result; nothing local depends on it.
    }
  }

  private republish(state: HostState, event: string, args: readonly unknown[]): void {
    const host = { id: state.entry.id, name: state.name }
    if (event === 'api-session/added') {
      const [summary] = args
      if (isRecord(summary)) {
        this.emitSessionEvent(event, [{ ...summary, host }])
        return
      }
    }
    this.emitSessionEvent(event, args)
  }

  private emitSessionEvent(event: string, args: readonly unknown[]): void {
    // The event vocabulary is the remote Host's; it may be newer than this one.
    ;(this.ownerContext.emit as (name: string, ...values: unknown[]) => void)(event, ...args)
  }

  private targetOf(state: HostState): SshTarget {
    return {
      sshTarget: state.entry.sshTarget,
      ...(state.entry.sshPort === undefined ? {} : { sshPort: state.entry.sshPort }),
      ...(state.entry.remoteHome === undefined ? {} : { remoteHome: state.entry.remoteHome }),
      timeoutMs: this.timeoutMs,
    }
  }

  private setState(state: HostState, status: RemoteHostStatus['status']): void {
    state.status = status
    if (status !== 'error') state.error = undefined
    this.ownerContext.emit('remote-hosts/changed')
  }

  private fail(state: HostState, error: unknown): void {
    const message = error instanceof RemoteHostFailure
      ? `${error.code}: ${error.message}`
      : error instanceof Error ? error.message : String(error)
    state.status = 'error'
    state.error = message.slice(0, MAX_ERROR_LENGTH)
    console.warn(`remote-hosts: could not attach ${state.name}: ${state.error}`)
    this.ownerContext.emit('remote-hosts/changed')
  }

  private async detach(state: HostState): Promise<void> {
    for (const [eventId, entry] of this.waterfalls) {
      if (entry.hostId !== state.entry.id) continue
      entry.pending.cancel(new Error('The remote Host detached'))
      this.waterfalls.delete(eventId)
    }
    state.abort?.abort()
    state.abort = undefined
    state.client?.close()
    state.client = undefined
    const events = state.events
    state.events = undefined
    await events
    const tunnel = state.tunnel
    state.tunnel = undefined
    state.pid = undefined
    if (tunnel !== undefined) await tunnel.close()
    state.status = 'idle'
    state.error = undefined
    this.ownerContext.emit('remote-hosts/changed')
  }

  private async detachAll(): Promise<void> {
    this.disposed = true
    await this.reconciliation.catch(() => { /* The failed reconciliation already reports each affected host. */ })
    await Promise.all([...this.states.values()].map(state => this.stop(state)))
  }
}

/**
 * Recognize one JSON object from an untrusted remote frame.
 * @param value - untrusted frame value.
 * @returns whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export { RemoteHostClient, RemoteHostFailure as RemoteHostCallFailure } from './remote-client.ts'
export type { WebInstanceDescriptor } from './instance-descriptor.ts'

/** Construct the owned lifecycle state of one configured destination. */
function createHostState(entry: RemoteHostEntry): HostState {
  return {
    entry, name: entry.name ?? entry.id, status: 'idle', error: undefined, pid: undefined,
    tunnel: undefined, client: undefined, abort: undefined, retry: undefined, attempts: 0,
    paused: false, task: undefined, events: undefined,
  }
}
