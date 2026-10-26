/**
 * Hosts panel: every known Session grouped by the machine that hosts it.
 *
 * Local Sessions form the first group; each SSH-attached Host contributes one
 * group named after it. A row opens the ordinary Conversation view, because a
 * remote Session is an ordinary Session to every consumer below this panel.
 */

import { useMemo, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId, RemoteHostEntry, RemoteHostStatus } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { HostsController, HostsState } from './controller.ts'
import { HostEditor } from './HostEditor.tsx'
import type { Translate } from './locales.ts'
import css from './HostsPanel.module.css'

export type { Translate } from './locales.ts'

/** Navigation, management operations, and the framework-bound status source. */
export interface HostsPanelInjected {
  hooks: { hosts: HostsController['store'] }
  openSession(sessionId: SessionId): void
  saveHost(entry: RemoteHostEntry, revision: number): Promise<boolean>
  removeHost(id: string, revision: number): Promise<boolean>
  reconnectHost(id: string): Promise<boolean>
  disconnectHost(id: string): Promise<boolean>
  refreshHosts(): void
  dismissNotice(): void
}

/** Root-scoped framework props and the injected connection operations. */
export type HostsPanelProps = PropsRuntime<'main'> & InjectFace<HostsPanelInjected> & PropsLocale<'remoteHosts'>

/** One rendered host section. */
interface HostGroup {
  /** Stable identity: the host id, or an empty marker for Local. */
  readonly key: string
  readonly label: string
  readonly note: string
  readonly sessions: readonly SessionSummary[]
  readonly host?: RemoteHostStatus
}

/**
 * Group catalog rows by the machine that hosts them.
 *
 * Subagent rows belong to their parent's conversation and blank rows are
 * navigation state rather than conversations, so neither becomes a row here.
 * Local leads; attached Hosts follow in display-name order.
 * @param list - current Session catalog.
 * @param t - namespace translator.
 * @returns ordered host sections.
 */
export function hostGroups(
  list: { readonly ids: readonly SessionId[]; readonly byId: Readonly<Record<string, SessionSummary>> },
  t: Translate,
  hosts: readonly RemoteHostStatus[] = [],
): HostGroup[] {
  const local: SessionSummary[] = []
  const remote = new Map<string, { label: string; sessions: SessionSummary[]; host?: RemoteHostStatus }>(
    hosts.map(host => [host.id, { label: host.name, sessions: [], host }]),
  )
  for (const id of list.ids) {
    const session = list.byId[id]
    if (session === undefined || session.origin === 'subagent' || session.blank) continue
    if (session.host === undefined) {
      local.push(session)
      continue
    }
    const existing = remote.get(session.host.id)
    if (existing === undefined) {
      remote.set(session.host.id, { label: session.host.name, sessions: [session] })
    } else {
      existing.sessions.push(session)
    }
  }
  const recent = (sessions: readonly SessionSummary[]): SessionSummary[] =>
    [...sessions].sort((left, right) => right.updatedAt - left.updatedAt)
  const groups: HostGroup[] = []
  if (local.length > 0) {
    groups.push({
      key: '',
      label: t('host.local'),
      note: t('host.localNote'),
      sessions: recent(local),
    })
  }
  for (const [key, group] of [...remote].sort((left, right) => left[1].label.localeCompare(right[1].label))) {
    groups.push({
      key,
      label: group.label,
      note: t('host.remoteNote'),
      sessions: recent(group.sessions),
      ...group.host === undefined ? {} : { host: group.host },
    })
  }
  return groups
}

/**
 * Render the host-grouped catalog.
 * @param props - catalog hook, navigation action, and localized copy.
 * @returns the panel body.
 */
export function HostsPanel(props: HostsPanelProps): ReactNode {
  const { useSessions, useHosts, t, ...actions } = props
  const list = useSessions(state => state)
  const state = useHosts(value => value)
  const groups = useMemo(() => hostGroups(list, t, state.catalog.hosts), [list, t, state.catalog.hosts])
  return <HostsPanelView groups={groups} state={state} actions={actions} t={t} />
}

/** Presentational connection data and actions. */
export interface HostsPanelViewProps {
  readonly groups: readonly HostGroup[]
  readonly state: HostsState
  readonly actions: Omit<HostsPanelInjected, 'hooks'>
  readonly t: Translate
}

/**
 * Render every configured host, its current status, and its visible Sessions.
 * @param props - Host groups, operation callbacks, and localized copy.
 * @returns Connection-management page.
 */
export function HostsPanelView({ groups, state, actions, t }: HostsPanelViewProps): ReactNode {
  const [editor, setEditor] = useState<{ entry: RemoteHostEntry | undefined; revision: number } | null>(null)
  const [removing, setRemoving] = useState<{ host: RemoteHostStatus; revision: number } | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const run = async (id: string, action: () => Promise<boolean>): Promise<void> => {
    setWorking(id)
    try { await action() } finally { setWorking(null) }
  }
  return (
    <div className={css.page} data-hosts-panel>
      <header className={css.header}>
        <div>
          <h1 className={css.title}>{t('panel.title')}</h1>
          <p className={css.description}>{t('panel.description')}</p>
        </div>
        <div className={css.actions}>
          <Button variant="outline" onClick={actions.refreshHosts}>{t('panel.refresh')}</Button>
          <Button variant="primary" onClick={() => { setEditor({ entry: undefined, revision: state.catalog.revision }) }} disabled={!state.catalog.writable}>{t('panel.add')}</Button>
        </div>
      </header>
      {state.error === null ? null : <p role="alert" className={css.error}>{state.error}</p>}
      {!state.catalog.writable && state.status === 'ready' ? <p className={css.hint}>{t('panel.readOnly')}</p> : null}
      {groups.length === 0 ? <div className={css.empty}><p>{t('panel.empty')}</p><p>{t('panel.noRemote')}</p></div> : null}
      {groups.map(group => (
        <section key={group.key} className={css.group} aria-label={group.label}>
          <div className={css.groupHeader}>
            <div className={css.hostIdentity}>
              <h2 className={css.groupLabel}>{group.label}</h2>
              <span className={css.groupNote}>{group.note}</span>
              {group.host === undefined ? null : <span role="status" className={css.status}>{t(`status.${group.host.status}`)}</span>}
              <span className={css.groupCount}>{t('host.count', { count: group.sessions.length })}</span>
            </div>
            {group.host === undefined ? null : (
              <div className={css.actions}>
                <Button size="sm" disabled={working === group.key} onClick={() => {
                  void run(group.key, () => actions.reconnectHost(group.key))
                }}>{t(group.host.status === 'idle' ? 'host.connect' : 'host.reconnect')}</Button>
                {group.host.status !== 'connected' && group.host.status !== 'connecting' ? null : (
                  <Button size="sm" disabled={working === group.key} onClick={() => {
                    void run(group.key, () => actions.disconnectHost(group.key))
                  }}>{t('host.disconnect')}</Button>
                )}
                <Button size="sm" disabled={!state.catalog.writable || working === group.key}
                  onClick={() => { setEditor({ entry: group.host, revision: state.catalog.revision }) }}>{t('host.edit')}</Button>
                <Button size="sm" disabled={!state.catalog.writable || working === group.key}
                  onClick={() => { setRemoving(group.host === undefined ? null : { host: group.host, revision: state.catalog.revision }) }}>{t('host.remove')}</Button>
              </div>
            )}
          </div>
          {group.host === undefined ? null : <p className={css.target}>{group.host.sshTarget}{group.host.sshPort === undefined ? '' : ` : ${group.host.sshPort}`}</p>}
          {group.host?.error === undefined ? null : <p role="alert" className={css.error}>{group.host.error}</p>}
          {group.sessions.length === 0 ? <p className={css.hint}>{t('panel.noSessions')}</p> : null}
          <ul className={css.rows}>
            {group.sessions.map(session => (
              <li key={session.id}>
                <button type="button" className={css.row} onClick={() => { actions.openSession(session.id) }}>
                  <span className={css.rowTitle}>{session.title ?? session.displayTitle}</span>
                  <span className={css.rowMeta}>
                    {session.running ? <span className={css.running} aria-hidden /> : null}
                    {new Date(session.updatedAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {state.catalog.hosts.length > 0 || groups.length === 0 ? null : <p className={css.hint}>{t('panel.noRemote')}</p>}
      {editor === null ? null : <HostEditor entry={editor.entry}
        save={entry => actions.saveHost(entry, editor.revision)} close={() => { setEditor(null) }} t={t} />}
      <Modal open={removing !== null} title={t('remove.title')} closeLabel={t('editor.close')}
        description={t('remove.description', { host: removing?.host.name ?? '' })} onClose={() => { if (working === null) setRemoving(null) }}
        footer={<>
          <Button disabled={working !== null} onClick={() => { setRemoving(null) }}>{t('editor.cancel')}</Button>
          <Button variant="primary" disabled={working !== null} onClick={() => {
            if (removing === null) return
            void run(removing.host.id, async () => {
              const removed = await actions.removeHost(removing.host.id, removing.revision)
              if (removed) setRemoving(null)
              return removed
            })
          }}>{t('remove.confirm')}</Button>
        </>}
      />
    </div>
  )
}
