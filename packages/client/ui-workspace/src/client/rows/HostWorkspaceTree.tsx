/** Attached Host tree using the Workspace browser's existing derivation and rows. */
import { useState } from 'react'
import { HoverCardGroup } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostWorkspaceTreeProps } from '../contract/host-tree.ts'
import { deriveGroups, orderByRecency, UNGROUPED_KEY } from '../tree.ts'
import { ProjectRowItem, SessionNodeItem } from './Rows.tsx'
import css from './WorkspaceBrowser.module.css'

/**
 * Render remote membership with Local's folder, status, selection and relative-time presentation.
 * @param props - Selected Host, authoritative Workspace membership, title filter and navigation.
 * @returns Collapsible Workspace groups; empty and loading states retain the tree's dimensions.
 */
export function HostWorkspaceTree({ hostId, label, workspaces, archivedSessionIds, pinnedSessionIds, query,
  loading, emptyLabel, openSession, useSessions, useSessionStatus, usePanelInfo, t }: HostWorkspaceTreeProps) {
  const list = useSessions(state => state)
  const statuses = useSessionStatus(state => state)
  const panelActive = usePanelInfo(info => info.activePanelId !== null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const current = panelActive ? undefined : Object.values(list.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
  const ordered = workspaces.map(workspace => ({ ...workspace, sessionIds: orderByRecency(workspace.sessionIds, list.byId) }))
  const groups = deriveGroups(list, ordered, { archivedSessionIds, pinnedSessionIds, archivedFilter: 'default' }, statuses,
    { expandedGroups: [...workspaces.map(workspace => workspace.workspaceId), UNGROUPED_KEY] }, hostId)
  const needle = query.toLocaleLowerCase()
  const visible = groups.flatMap((group) => {
    const sessions = needle === '' ? group.sessions : group.sessions.filter(session => session.title.toLocaleLowerCase().includes(needle))
    if (needle !== '' && sessions.length === 0) return []
    return [{ ...group, containsCurrent: !panelActive && group.containsCurrent, expanded: needle !== '' || !collapsed.has(group.key), sessions }]
  })
  const now = Date.now()
  return <HoverCardGroup>
    <div role="tree" aria-label={label} aria-busy={loading} data-host-workspace-tree={hostId}>
      {loading && [0, 1].map(index => <div key={index} className={css.skeletonRow} aria-hidden="true">
        <span className={css.skeletonDot} /><span className={css.skeletonBars}><span className={css.skeletonBar} /></span>
      </div>)}
      {!loading && visible.length === 0 && <p className={css.searchStatus}>{emptyLabel}</p>}
      {!loading && visible.map(group => <div key={group.key} className={css.groupSection} role="group" data-host-workspace={group.key}>
        <ProjectRowItem group={group} containsCurrentDescendant={group.sessions.some(session => session.id === current)}
          tabIndex={0} onToggle={() => { setCollapsed((previous) => {
            const next = new Set(previous)
            if (next.has(group.key)) next.delete(group.key)
            else next.add(group.key)
            return next
          }) }} t={t} />
        {group.expanded && group.sessions.map(node => <SessionNodeItem key={node.id} node={node} currentId={current}
          now={now} onOpen={openSession} tabIndex={0} t={t} />)}
      </div>)}
    </div>
  </HoverCardGroup>
}
