/** Connection configuration and live status read through the Host Remote API. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote, RemoteHostEntry, RemoteHostsSnapshot, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { Translate } from './locales.ts'

/** Host data plus page loading and operation feedback. */
export interface HostsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  catalog: RemoteHostsSnapshot
  error: string | null
  notice: { seq: number; text: string; tone: 'success' | 'error' } | null
}

/** Owns requests and invalidations across page remounts. */
export class HostsController {
  /** Shared connection settings, states, and operation feedback. */
  readonly store = createSnapshotStore<HostsState>({
    status: 'idle', catalog: { hosts: [], writable: false, revision: 0 }, error: null, notice: null,
  })
  private pending: Promise<void> | undefined
  private again = false
  private disposed = false
  private seq = 0

  /**
   * @param remote - Generated connection-management namespace.
   * @param t - Localized operation feedback.
   */
  constructor(private readonly remote: Pick<ClientRemote['remoteHosts'], 'describe' | 'setHosts' | 'reconnect' | 'disconnectHost'>, private readonly t: Translate) {}

  /** Refresh status, preserving any invalidation that arrives during a read.
   * @returns Completion of all coalesced reads.
   */
  load(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.pending !== undefined) { this.again = true; return this.pending }
    if (this.store.getSnapshot().status === 'idle') this.store.update((state) => { state.status = 'loading' })
    this.pending = this.read().finally(() => { this.pending = undefined })
    return this.pending
  }

  private async read(): Promise<void> {
    do {
      this.again = false
      try {
        const result = await this.remote.describe()
        if (this.disposed) return
        if (!result.ok) throw new Error(result.error.message)
        this.store.update((state) => { state.catalog = result.value; state.status = 'ready'; state.error = null })
      } catch (error) {
        if (this.disposed) return
        const reason = error instanceof Error ? error.message : String(error)
        this.store.update((state) => { state.status = 'error'; state.error = this.t('load.failed', { reason }) })
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- A concurrent load can invalidate the awaited read.
    } while (this.again && !this.disposed)
  }

  /** Save a new or edited connection without replacing concurrent profile edits.
   * @param entry - Connection fields from the editor.
   * @param revision - Configuration revision at the time the editor opened.
   * @returns Whether the edit was persisted.
   */
  save(entry: RemoteHostEntry, revision: number = this.store.getSnapshot().catalog.revision): Promise<boolean> {
    const hosts = this.entries()
    const index = hosts.findIndex(host => host.id === entry.id)
    if (index === -1) hosts.push(entry)
    else hosts[index] = entry
    return this.replace(hosts, revision)
  }

  /** Remove a connection while preserving every remote Session.
   * @param id - Configured host identity.
   * @param revision - Configuration revision at the time removal was requested.
   * @returns Whether removal was persisted.
   */
  remove(id: string, revision: number = this.store.getSnapshot().catalog.revision): Promise<boolean> {
    return this.replace(this.entries().filter(host => host.id !== id), revision)
  }

  private entries(): RemoteHostEntry[] {
    return this.store.getSnapshot().catalog.hosts.map(({ id, name, sshTarget, sshPort, remoteHome }) => ({
      id, name, sshTarget, ...sshPort === undefined ? {} : { sshPort }, ...remoteHome === undefined ? {} : { remoteHome },
    }))
  }

  private replace(hosts: RemoteHostEntry[], revision: number): Promise<boolean> {
    return this.perform(() => this.remote.setHosts({ hosts, expectedRevision: revision }), 'operation.saved')
  }

  /** Reconnect immediately, including after a failed attempt.
   * @param id - Configured host identity.
   * @returns Whether the request completed.
   */
  reconnect(id: string): Promise<boolean> { return this.perform(() => this.remote.reconnect(id), 'operation.reconnected') }

  /** Disconnect without removing saved settings.
   * @param id - Configured host identity.
   * @returns Whether the request completed.
   */
  disconnect(id: string): Promise<boolean> { return this.perform(() => this.remote.disconnectHost(id), 'operation.disconnected') }

  private async perform(operation: () => Promise<RemoteResult<RemoteHostsSnapshot>>, success: 'operation.saved' | 'operation.reconnected' | 'operation.disconnected'): Promise<boolean> {
    try {
      const result = await operation()
      if (this.disposed) return false
      if (!result.ok) throw new Error(result.error.code === 'remote-hosts/conflict' ? this.t('operation.conflict') : result.error.message)
      this.store.update((state) => { state.catalog = result.value })
      await this.load()
      const failed = result.value.hosts.find(host => host.status === 'error')
      this.notice(failed === undefined ? this.t(success) : this.t('operation.connectionFailed', { host: failed.name }), failed === undefined ? 'success' : 'error')
      return true
    } catch (error) {
      if (!this.disposed) {
        const reason = error instanceof Error ? error.message : String(error)
        this.notice(this.t('operation.failed', { reason }), 'error')
        await this.load()
      }
      return false
    }
  }

  private notice(text: string, tone: 'success' | 'error'): void {
    const seq = ++this.seq
    this.store.update((state) => { state.notice = { seq, text, tone } })
  }

  /** Clear the current transient notification. */
  dismissNotice(): void { this.store.update((state) => { state.notice = null }) }

  /** Prevent in-flight reads and writes from publishing after plugin disposal. */
  dispose(): void { this.disposed = true }
}
