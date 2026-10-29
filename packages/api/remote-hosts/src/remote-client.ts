/**
 * Raw Typert Remote wire client for one attached remote dsh Web Host.
 *
 * The local Host is itself a Client of each attached remote Host. It speaks
 * the public `/api` wire contract — one HTTP unary call per method and one
 * multiplexed `/api/remote.mux` socket per remote process — instead of
 * mounting the remote's generated Client contribution, so the remote may run
 * any dsh version that speaks this protocol.
 * @module @deepseek-ai/dsh-api-remote-hosts/remote-client
 */

import { createWebConnectionRpc } from '@deepseek-ai/dsh-client-connection'
import WebSocket, { type RawData } from 'ws'

/** One failure reported by the remote Host for a Remote call. */
export interface RemoteWireFailure {
  /** Stable Remote error code, for example `gateway/cancelled`. */
  readonly code: string
  /** Human-readable description. */
  readonly message: string
  /** Code-specific details. */
  readonly details: unknown
}

/** A Remote call the remote Host refused, or a transport failure it never answered. */
export class RemoteHostFailure extends Error {
  override readonly name = 'RemoteHostFailure'
  /** Preserve the remote failure code through the forwarding Gateway. */
  readonly isDSHRemoteError: true = true

  /**
   * @param failure - code, message, and details reported for the call.
   */
  constructor(readonly failure: RemoteWireFailure) {
    super(`${failure.code}: ${failure.message}`)
  }

  /** The Remote error code. */
  get code(): string {
    return this.failure.code
  }

  /** Code-specific details. */
  get details(): unknown {
    return this.failure.details
  }
}

/** Connection facts of one remote Host reached through a local tunnel. */
export interface RemoteClientOptions {
  /** Loopback HTTP origin the tunnel forwards to the remote listener. */
  readonly baseUrl: string
  /** Process launch token, exchanged once for an authenticated API cookie. */
  readonly token: string
  /** Deadline for one authentication, HTTP request, socket handshake, or heartbeat reply. */
  readonly timeoutMs: number
  /** Interval between socket liveness probes, in milliseconds. */
  readonly heartbeatIntervalMs: number
  /** HTTP implementation; the Host passes the process `fetch`. */
  readonly fetch?: typeof fetch
}

/** One downlink item of an opened logical stream. */
export type RemoteStreamItem =
  | { readonly kind: 'item'; readonly value: unknown }
  | { readonly kind: 'end' }
  | { readonly kind: 'failure'; readonly failure: RemoteWireFailure }

interface SocketWake {
  readonly push: (item: RemoteStreamItem) => void
  readonly fail: (failure: RemoteWireFailure) => void
}

/** Mux frames observed from the remote Host, after JSON decoding. */
type ServerFrame =
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }
  | { readonly type: 'end'; readonly streamId: string }
  | { readonly type: 'error'; readonly streamId: string; readonly error: RemoteWireFailure }

/**
 * Attach to one remote Host: authenticate once, then call unary methods and
 * open logical streams over a single multiplexed socket.
 *
 * The API Peer that `/connect` publishes owns exactly one WebSocket, so every
 * stream shares that socket; closing the client closes the Peer's streams.
 */
export class RemoteHostClient {
  private readonly baseUrl: URL
  private readonly token: string
  private readonly lifetime = new AbortController()
  private readonly timeoutMs: number
  private readonly heartbeatIntervalMs: number
  private heartbeat: NodeJS.Timeout | undefined
  private pongDeadline: NodeJS.Timeout | undefined
  private readonly fetchImpl: typeof fetch
  private cookie: string | undefined
  private socket: WebSocket | undefined
  private opening: Promise<WebSocket> | undefined
  private nextStreamId = 0
  private readonly streams = new Map<string, SocketWake>()
  private closed: RemoteWireFailure | undefined

  /**
   * @param options - tunnel origin and launch token.
   */
  constructor(options: RemoteClientOptions) {
    this.baseUrl = new URL(options.baseUrl)
    this.token = options.token
    this.timeoutMs = options.timeoutMs
    this.heartbeatIntervalMs = options.heartbeatIntervalMs
    this.fetchImpl = options.fetch ?? fetch
  }

  /** Close the socket and fail every stream that is still open. */
  close(): void {
    this.clearHeartbeat()
    this.lifetime.abort()
    const failure: RemoteWireFailure = {
      code: 'remote-host/closed',
      message: 'The remote Host connection was closed',
      details: {},
    }
    if (this.closed === undefined) this.closed = failure
    this.opening = undefined
    this.socket?.close()
    this.socket = undefined
    for (const awake of [...this.streams.values()]) awake.fail(failure)
    this.streams.clear()
  }

  /**
   * Invoke one Remote method through the remote Host's HTTP channel.
   * @param endpoint - canonical `namespace/method` endpoint.
   * @param args - named arguments accepted by that method.
   * @param signal - caller cancellation; aborting before the response settles rejects.
   * @returns the decoded successful value.
   * @throws RemoteHostFailure when the Host refuses the call or the carrier fails.
   */
  async invoke(endpoint: string, args: object, signal?: AbortSignal): Promise<unknown> {
    const requestSignal = AbortSignal.any([
      this.lifetime.signal, AbortSignal.timeout(this.timeoutMs), ...signal === undefined ? [] : [signal],
    ])
    const cookie = await this.apiCookie(requestSignal)
    requestSignal.throwIfAborted()
    const rpc = createWebConnectionRpc(async (route, init) => {
      const headers = new Headers(init.headers)
      headers.set('cookie', cookie)
      let response: Response
      try {
        response = await this.fetchImpl(new URL(`/${String(route)}`, this.baseUrl), { ...init, headers, signal: requestSignal })
      } catch (error: unknown) {
        requestSignal.throwIfAborted()
        throw new RemoteHostFailure({ code: 'remote-host/unreachable',
          message: error instanceof Error ? error.message : String(error), details: {} })
      }
      if (!response.ok) throw new RemoteHostFailure({ code: 'remote-host/http',
        message: `remote Host answered ${String(response.status)} for ${endpoint}`, details: { status: response.status } })
      return response
    })
    const result = await rpc.call('/api', endpoint, { args }, requestSignal).catch((error: unknown) => {
      requestSignal.throwIfAborted()
      if (error instanceof RemoteHostFailure) throw error
      throw new RemoteHostFailure({ code: 'remote-host/protocol',
        message: error instanceof Error ? error.message : String(error), details: {} })
    })
    if (result.ok) return result.value
    throw new RemoteHostFailure(result.error)
  }

  /**
   * Open one logical Remote stream and iterate its downlink.
   *
   * The generator sends one `cancel` frame and releases its queue when the
   * caller stops iterating or the signal aborts.
   * @param endpoint - canonical endpoint, or the Gateway-owned `$events`.
   * @param payload - complete stream payload, normally `{ args }`.
   * @param signal - cancellation for this logical stream only.
   * @returns the stream's downlink values.
   */
  async *stream(
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<unknown, void, undefined> {
    const socket = await this.mux()
    signal?.throwIfAborted()
    const streamId = String(this.nextStreamId++)
    const queue = new StreamQueue()
    this.streams.set(streamId, queue)
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }))
    const abort = (): void => {
      socket.send(JSON.stringify({ type: 'cancel', streamId }))
      queue.push({ kind: 'failure', failure: {
        code: 'gateway/cancelled',
        message: 'The stream was cancelled',
        details: {},
      } })
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        const item = await queue.next()
        if (item === undefined) return
        if (item.kind === 'failure') throw new RemoteHostFailure(item.failure)
        if (item.kind !== 'item') return
        yield item.value
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      this.streams.delete(streamId)
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'cancel', streamId }))
      }
    }
  }

  private async apiCookie(signal: AbortSignal): Promise<string> {
    if (this.cookie !== undefined) return this.cookie
    const url = new URL('/connect', this.baseUrl)
    url.searchParams.set('token', this.token)
    url.searchParams.set('interactions', 'answer')
    let response: Response
    try {
      response = await this.fetchImpl(url, { redirect: 'manual', signal })
    } catch (error: unknown) {
      throw new RemoteHostFailure({
        code: 'remote-host/unreachable',
        message: error instanceof Error ? error.message : String(error),
        details: {},
      })
    }
    const cookies = response.headers.getSetCookie()
    if (response.status !== 302 || cookies.length === 0) {
      throw new RemoteHostFailure({
        code: 'remote-host/unauthenticated',
        message: `remote Host refused the launch token with status ${String(response.status)}`,
        details: { status: response.status },
      })
    }
    this.cookie = cookies.map(cookie => cookie.split(';')[0] ?? '').filter(part => part !== '').join('; ')
    return this.cookie
  }

  private async mux(): Promise<WebSocket> {
    if (this.closed !== undefined) throw new RemoteHostFailure(this.closed)
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket
    this.opening ??= this.openMux()
    const socket = await this.opening
    this.opening = undefined
    return socket
  }

  private async openMux(): Promise<WebSocket> {
    const cookie = await this.apiCookie(AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs)]))
    this.lifetime.signal.throwIfAborted()
    const url = new URL('/api/remote.mux', this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url, { headers: { cookie }, handshakeTimeout: this.timeoutMs })
    this.socket = socket
    socket.on('message', (data: RawData) => { this.receive(data) })
    socket.on('close', () => {
      this.clearHeartbeat()
      this.socket = undefined
      this.closed ??= {
        code: 'remote-host/closed',
        message: 'The remote Host connection ended',
        details: {},
      }
      for (const awake of [...this.streams.values()]) awake.fail(this.closed)
      this.streams.clear()
    })
    socket.on('error', (error: Error) => {
      this.clearHeartbeat()
      for (const awake of [...this.streams.values()]) {
        awake.fail({ code: 'remote-host/unreachable', message: error.message, details: {} })
      }
      this.streams.clear()
    })
    socket.on('pong', () => {
      if (this.pongDeadline === undefined) return
      clearTimeout(this.pongDeadline)
      this.pongDeadline = undefined
      this.scheduleHeartbeat(socket)
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    this.scheduleHeartbeat(socket)
    return socket
  }

  private scheduleHeartbeat(socket: WebSocket): void {
    if (this.closed !== undefined || socket.readyState !== WebSocket.OPEN) return
    this.heartbeat = setTimeout(() => {
      this.heartbeat = undefined
      this.pongDeadline = setTimeout(() => {
        this.pongDeadline = undefined
        this.closed = { code: 'remote-host/timeout', message: 'The remote Host did not answer the connection heartbeat', details: {} }
        this.failAll(this.closed)
        socket.terminate()
      }, this.timeoutMs)
      this.pongDeadline.unref()
      socket.ping()
    }, this.heartbeatIntervalMs)
    this.heartbeat.unref()
  }

  private clearHeartbeat(): void {
    clearTimeout(this.heartbeat)
    clearTimeout(this.pongDeadline)
    this.heartbeat = undefined
    this.pongDeadline = undefined
  }

  private receive(data: RawData): void {
    let frame: ServerFrame
    try {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data
      frame = JSON.parse(bytes.toString('utf8')) as ServerFrame
    } catch {
      this.failAll({
        code: 'remote-host/protocol',
        message: 'remote Host sent a malformed stream frame',
        details: {},
      })
      return
    }
    const awake = this.streams.get(frame.streamId)
    if (awake === undefined) return
    switch (frame.type) {
      case 'item':
        awake.push({ kind: 'item', value: frame.value })
        return
      case 'end':
        awake.push({ kind: 'end' })
        this.streams.delete(frame.streamId)
        return
      case 'error':
        awake.push({ kind: 'failure', failure: frame.error })
        this.streams.delete(frame.streamId)
        return
    }
  }

  private failAll(failure: RemoteWireFailure): void {
    for (const awake of [...this.streams.values()]) awake.fail(failure)
    this.streams.clear()
  }
}

/** Pull queue bridging socket callbacks to one stream generator. */
class StreamQueue implements SocketWake {
  private readonly buffered: RemoteStreamItem[] = []
  private waiter: (() => void) | undefined
  private ended = false

  push(item: RemoteStreamItem): void {
    if (this.ended) return
    this.buffered.push(item)
    this.waiter?.()
    this.waiter = undefined
  }

  fail(failure: RemoteWireFailure): void {
    this.push({ kind: 'failure', failure })
  }

  async next(): Promise<RemoteStreamItem | undefined> {
    while (this.buffered.length === 0) {
      if (this.ended) return undefined
      await new Promise<void>((resolve) => { this.waiter = resolve })
    }
    const item = this.buffered.shift()
    if (item?.kind === 'end' || item?.kind === 'failure') this.ended = true
    return item
  }
}
