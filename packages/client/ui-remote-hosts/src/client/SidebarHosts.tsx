/** Remote host groups rendered beside the sidebar's Local workspace group. */
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { hostGroups } from './HostsPanel.tsx'
import type { HostsPanelInjected } from './HostsPanel.tsx'
import css from './SidebarHosts.module.css'

/** Status source and the two navigation actions used by the sidebar. */
export type SidebarHostsInjected = Pick<HostsPanelInjected, 'hooks' | 'openSession'> & {
  manageHosts(): void
}

/** Sidebar owner query, standard hooks, and localized connection navigation. */
export type SidebarHostsProps = Pick<PropsRuntime<'sidebar.workspaces.hosts'>, 'query' | 'useSessions' | 'usePanelInfo'>
  & InjectFace<SidebarHostsInjected> & PropsLocale<'remoteHosts'>

/**
 * Show configured hosts even while disconnected, with directly openable Sessions.
 * @param props - Host status, Session catalog, title query, and navigation.
 * @returns Remote groups and the connection-management entry.
 */
export function SidebarHosts({ useSessions, useHosts, usePanelInfo, query, openSession, manageHosts, t }: SidebarHostsProps): ReactNode {
  const list = useSessions(state => state)
  const state = useHosts(value => value)
  const panelActive = usePanelInfo(info => info.activePanelId !== null)
  const groups = hostGroups(list, t, state.catalog.hosts).filter(group => group.key !== '')
  const needle = query.toLocaleLowerCase()
  return <div className={css.root} data-sidebar-hosts>
    {groups.map((group) => {
      const sessions = group.sessions.filter(session => session.displayTitle.toLocaleLowerCase().includes(needle))
      const status = group.host?.status ?? 'connected'
      return <details key={group.key} open className={css.group} data-sidebar-host={group.key}>
        <summary className={css.heading}>
          <span className={css.name} title={group.label}>{group.label}</span>
          <span className={css.status} data-status={status} role="status" aria-label={t(`status.${status}`)} title={t(`status.${status}`)} />
          <span className={css.count} aria-label={t('host.count', { count: group.sessions.length })}>{group.sessions.length}</span>
        </summary>
        <div className={css.sessions}>
          {sessions.map(session => <button
            key={session.id}
            type="button"
            className={css.session}
            title={session.displayTitle || t('session.untitled')}
            aria-current={!panelActive && (session.retainedBy.mainView ?? 0) > 0 ? 'page' : undefined}
            onClick={() => { openSession(session.id) }}
          >
            <span className={css.sessionTitle}>{session.displayTitle || t('session.untitled')}</span>
          </button>)}
          {sessions.length === 0 && <p className={css.empty}>{needle !== '' ? t('sidebar.noMatches') : status === 'connected' ? t('panel.noSessions') : t(`status.${status}`)}</p>}
        </div>
      </details>
    })}
    {state.status === 'loading' && <p className={css.empty} role="status">{t('sidebar.loading')}</p>}
    {state.error !== null && <p className={css.error} role="alert">{state.error}</p>}
    <button type="button" className={css.manage} onClick={manageHosts}>{t('sidebar.manage')}</button>
  </div>
}
