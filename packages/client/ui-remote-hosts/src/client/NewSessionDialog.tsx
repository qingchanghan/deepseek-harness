/** Select a Host and Workspace before creating a conversation. */
import { useState, type ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteHostWorkspace, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { HostsPanelInjected } from './HostsPanel.tsx'
import type { createNewSessionStore } from './new-session-store.ts'
import type {} from './workspace-resource.ts'
import css from './HostsPanel.module.css'

/** Operations always carry the explicitly selected Host. */
export type NewSessionInjected = Pick<HostsPanelInjected, 'hooks' | 'reconnectHost'> & {
  createSession(hostId: string | null, workspace: RemoteHostWorkspace): Promise<void>
  addWorkspace(hostId: string | null, path: string): Promise<RemoteHostWorkspace>
}

/** Root overlay seats and its registration-owned viewing state. */
export type NewSessionProps = PropsRuntime<'shell.overlay'> & PropsLocale<'remoteHosts'>
  & PropsStore<ReturnType<typeof createNewSessionStore>> & InjectFace<NewSessionInjected>

/**
 * Mount a fresh picker for each New Session gesture.
 * @param props - Shared picker state and Host operations.
 * @returns The open picker, or no overlay.
 */
export function NewSessionDialog(props: NewSessionProps): ReactNode {
  const request = props.useStore(state => state.request)
  return request === null ? null : <DestinationPicker {...props} initialHostId={request.hostId} />
}

function DestinationPicker(props: NewSessionProps & { initialHostId: string | null }): ReactNode {
  const { t, actions, useHosts, useWorkspaces, useResource, initialHostId } = props
  const hosts = useHosts(state => state.catalog.hosts)
  const local = useWorkspaces(state => state)
  const [hostId, setHostId] = useState(initialHostId)
  const [selected, setSelected] = useState<WorkspaceId | undefined>()
  const [revision, setRevision] = useState(0)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const host = hosts.find(item => item.id === hostId)
  const connected = hostId === null || host?.status === 'connected'
  const remote = useResource<'remote-workspaces'>(hostId === null || !connected ? ''
    : `dsh-resource://remote-workspaces/${encodeURIComponent(hostId)}?revision=${revision}`)
  const ready = connected && (hostId === null ? local.phase === 'ready' : remote.status === 'live')
  const items = hostId === null ? local.items : remote.value?.items ?? []
  const workspace = items.find(item => item.workspaceId === selected) ?? (selected === undefined ? items[0] : undefined)
  const failure = remote.status === 'failed' ? remote.failure?.message ?? t('new.loadFailed') : null
  const chooseHost = (id: string | null): void => {
    setHostId(id); setSelected(undefined); setPath(''); setError(null)
  }
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null)
    try { await operation() } catch (reason) {
      setError(t('operation.failed', { reason: reason instanceof Error ? reason.message : String(reason) }))
    } finally { setBusy(false) }
  }
  return <Modal open title={t('new.title')} description={t('new.description')} closeLabel={t('editor.close')}
    onClose={() => { if (!busy) actions.close() }}
    footer={<>
      <Button disabled={busy} onClick={actions.close}>{t('editor.cancel')}</Button>
      <Button variant="primary" disabled={busy || !ready || workspace === undefined} onClick={() => {
        if (workspace === undefined) return
        void run(async () => { await props.createSession(hostId, workspace); actions.close() })
      }}>{t(busy ? 'new.working' : 'new.create')}</Button>
    </>}
  >
    <div className={css.form} data-new-session-picker>
      <div className={css.field}>
        <span>{t('new.host')}</span>
        <div className={css.actions} role="radiogroup" aria-label={t('new.host')}>
          {[{ id: null, name: t('host.local') }, ...hosts].map(item => <Button key={item.id ?? 'local'}
            className={css.hostChoice} title={item.name} role="radio" aria-checked={hostId === item.id} variant={hostId === item.id ? 'outline' : 'ghost'}
            disabled={busy} onClick={() => { chooseHost(item.id) }}>{item.name}</Button>)}
        </div>
      </div>
      {!connected && <div className={css.actions}>
        <p role="status" className={css.hint}>{t('new.connectFirst')}</p>
        {host !== undefined && <Button disabled={busy} onClick={() => {
          void run(async () => { await props.reconnectHost(host.id); setRevision(value => value + 1) })
        }}>{t('host.connect')}</Button>}
      </div>}
      {connected && !ready && failure === null && <p role="status">{t('new.loading')}</p>}
      {failure !== null && <div><p role="alert" className={css.error}>{failure}</p>
        <Button disabled={busy} onClick={() => { setRevision(value => value + 1) }}>{t('panel.refresh')}</Button></div>}
      {ready && <div className={css.field}>
        <span>{t('new.workspace')}</span>
        <div className={css.workspaceChoices} role="radiogroup" aria-label={t('new.workspace')}>
          {items.map(item => <button key={item.workspaceId} type="button" role="radio"
            aria-checked={workspace?.workspaceId === item.workspaceId} className={css.workspaceChoice} disabled={busy}
            onClick={() => { setSelected(item.workspaceId) }}>
            <span>{item.title || item.path}</span><span className={css.hint}>{item.path}</span>
          </button>)}
        </div>
        {items.length === 0 && <p className={css.hint}>{t('new.empty')}</p>}
      </div>}
      {connected && <form className={css.field} onSubmit={(event) => {
        event.preventDefault()
        if (path.trim() === '') return
        void run(async () => {
          const added = await props.addWorkspace(hostId, path.trim())
          setSelected(added.workspaceId); setPath(''); setRevision(value => value + 1)
        })
      }}>
        <label className={css.field}><span>{t('new.path')}</span>
          <Input value={path} onChange={(event) => { setPath(event.target.value) }} disabled={busy} required />
        </label>
        <span className={css.hint}>{t('new.pathHelp')}</span>
        <Button type="submit" variant="outline" disabled={busy || path.trim() === ''}>{t('new.addWorkspace')}</Button>
      </form>}
      {error !== null && <p role="alert" className={css.error}>{error}</p>}
    </div>
  </Modal>
}
