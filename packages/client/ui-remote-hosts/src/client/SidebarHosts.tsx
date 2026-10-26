/** Remote host groups rendered beside the sidebar's Local workspace group. */
import { useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from './workspace-resource.ts'
import { hostGroups } from './HostsPanel.tsx'
import type { HostsPanelInjected } from './HostsPanel.tsx'
import css from './SidebarHosts.module.css'

/** Status source and the two navigation actions used by the sidebar. */
export type SidebarHostsInjected = Pick<HostsPanelInjected, 'hooks' | 'openSession'> & {
  manageHosts(): void
}

/** Sidebar owner query, standard hooks, and localized connection navigation. */
export type SidebarHostsProps = Pick<PropsRuntime<'sidebar.workspaces.hosts'>, 'query' | 'useSessions' | 'useResource'>
  & InjectFace<SidebarHostsInjected> & PropsLocale<'remoteHosts'> & PropsRenderFactories

/**
 * Show configured hosts even while disconnected, with directly openable Sessions.
 * @param props - Host status, Session catalog, title query, and navigation.
 * @returns Remote groups and the connection-management entry.
 */
export function SidebarHosts(props: SidebarHostsProps): ReactNode {
  const { useSessions, useHosts, manageHosts, t } = props
  const list = useSessions(state => state)
  const state = useHosts(value => value)
  const groups = hostGroups(list, t, state.catalog.hosts).filter(group => group.key !== '')
  return <div className={css.root} data-sidebar-hosts>
    {groups.map((group) => {
      const status = group.host?.status ?? 'connected'
      return <details key={group.key} open className={css.group} data-sidebar-host={group.key}>
        <summary className={css.heading}>
          <span className={css.name} title={group.label}>{group.label}</span>
          <span className={css.status} data-status={status} role="status" aria-label={t(`status.${status}`)} title={t(`status.${status}`)} />
          <span className={css.count} aria-label={t('host.count', { count: group.sessions.length })}>{group.sessions.length}</span>
        </summary>
        {status === 'connected'
          ? <HostWorkspaces {...props} hostId={group.key} label={group.label} />
          : <p className={css.empty}>{t(`status.${status}`)}</p>}
      </details>
    })}
    {state.status === 'loading' && <p className={css.empty} role="status">{t('sidebar.loading')}</p>}
    {state.error !== null && <p className={css.error} role="alert">{state.error}</p>}
    <button type="button" className={css.manage} onClick={manageHosts}>{t('sidebar.manage')}</button>
  </div>
}

function HostWorkspaces({ hostId, label, useResource, renderFactorySlot, openSession, query, t }:
  Pick<SidebarHostsProps, 'useResource' | 'renderFactorySlot' | 'openSession' | 'query' | 't'> & { hostId: string; label: string }) {
  const [revision, setRevision] = useState(0)
  const resource = useResource<'remote-workspaces'>(`dsh-resource://remote-workspaces/${encodeURIComponent(hostId)}?revision=${revision}`)
  const value = resource.value
  return <>
    {(value !== undefined || resource.status !== 'failed') && renderFactorySlot('workspace.host.tree', {
      hostId, label, query, openSession,
      workspaces: value?.items ?? [], archivedSessionIds: value?.archivedSessionIds ?? [], pinnedSessionIds: value?.pinnedSessionIds ?? [],
      loading: value === undefined && resource.status !== 'failed',
      emptyLabel: query === '' ? t('panel.noSessions') : t('sidebar.noMatches'),
    })}
    {resource.status === 'failed' && <div>
      <p role="alert" className={css.error}>{t('new.loadFailed')}</p>
      <button type="button" className={css.manage} onClick={() => { setRevision(value => value + 1) }}>{t('panel.refresh')}</button>
    </div>}
  </>
}
