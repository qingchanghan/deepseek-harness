// @vitest-environment jsdom
/** Attached Host membership reuses the Local tree's rows, time labels and navigation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { HostWorkspaceTreeProps } from '../src/client/contract/host-tree.ts'
import { HostWorkspaceTree } from '../src/client/rows/HostWorkspaceTree.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const now = 1_700_000_000_000
const sid = (id: string) => id as SessionId
const workspace = (id: string, members: string[]): WorkspaceView => ({
  workspaceId: id as WorkspaceId, path: `/remote/${id}`, title: id, sessionIds: members.map(sid),
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})

function props(): HostWorkspaceTreeProps {
  const rows: SessionSummary[] = ['older', 'newer', 'loose', 'local', 'other', 'child', 'archive', 'blank'].map(id => ({
    id: sid(id), displayTitle: id, title: id, running: id === 'newer', blank: id === 'blank',
    updatedAt: now - (id === 'older' ? 120_000 : 60_000), retainedBy: id === 'older' ? { mainView: 1 } : {},
    ...id === 'local' ? {} : { host: { id: id === 'other' ? 'other-host' : 'h20', name: 'H20' } },
    ...id === 'child' ? { origin: 'subagent' as const } : {},
  }))
  const list: SessionListState = {
    ids: rows.map(row => row.id), byId: Object.fromEntries(rows.map(row => [row.id, row])),
    phase: 'ready', projectionsBySession: {},
  }
  return {
    hostId: 'h20', label: 'H20', workspaces: [workspace('sglang', ['older', 'newer', 'child', 'archive', 'blank']), workspace('vllm', [])],
    archivedSessionIds: [sid('archive')], pinnedSessionIds: [], query: '', loading: false, emptyLabel: 'No matches',
    openSession: vi.fn(), t: makeTranslate(zh, commonZh), useSessions: selector => selector(list),
    useSessionStatus: selector => selector(new Map()), usePanelInfo: selector => selector({ activePanelId: null }),
  }
}

describe('attached Host workspace tree', () => {
  it('groups by saved membership, sorts by activity, and retains Local row presentation', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const face = props()
    const view = render(<HostWorkspaceTree {...face} />)
    const group = view.container.querySelector('[data-host-workspace="sglang"]')!
    expect(within(group as HTMLElement).getAllByRole('treeitem').map(row => row.textContent)).toEqual(['sglang', '进行中newer1分钟', 'older2分钟'])
    expect(screen.getByText('vllm')).toBeTruthy()
    expect(screen.getByText(zh['group.ungrouped'])).toBeTruthy()
    expect(screen.getByText('loose')).toBeTruthy()
    for (const title of ['local', 'other', 'child', 'archive', 'blank']) expect(screen.queryByText(title)).toBeNull()
    expect(screen.getByText('sglang').closest('[role="treeitem"]')?.querySelector('svg')).toBeTruthy()
    expect(screen.getByText('newer').closest('[role="treeitem"]')?.querySelector('[data-state="ongoing"]')).toBeTruthy()
    const selected = screen.getByText('older').closest('[role="treeitem"]')!
    expect(selected.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(selected)
    fireEvent.keyDown(selected, { key: 'Enter' })
    expect(face.openSession).toHaveBeenNthCalledWith(1, sid('older'))
    expect(face.openSession).toHaveBeenNthCalledWith(2, sid('older'))
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('collapses from the keyboard, reveals title matches, and follows membership updates', () => {
    const face = props()
    const view = render(<HostWorkspaceTree {...face} />)
    const folder = screen.getByText('sglang').closest('[role="treeitem"]')!
    fireEvent.keyDown(folder, { key: ' ' })
    expect(folder.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('older')).toBeNull()
    view.rerender(<HostWorkspaceTree {...face} query="OLDER" />)
    expect(screen.getByText('older')).toBeTruthy()
    expect(screen.queryByText('newer')).toBeNull()
    expect(screen.queryByText('vllm')).toBeNull()
    view.rerender(<HostWorkspaceTree {...face} />)
    expect(screen.queryByText('older')).toBeNull()
    view.rerender(<HostWorkspaceTree {...face} workspaces={[workspace('renamed', ['older']), workspace('vllm', ['newer'])]} />)
    expect(view.container.querySelector('[data-host-workspace="renamed"]')?.textContent).toContain('older')
    expect(view.container.querySelector('[data-host-workspace="vllm"]')?.textContent).toContain('newer')
  })

  it('keeps loading and empty states distinct', () => {
    const face = props()
    const view = render(<HostWorkspaceTree {...face} loading />)
    expect(screen.getByRole('tree').getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText('No matches')).toBeNull()
    view.rerender(<HostWorkspaceTree {...face} query="absent" />)
    expect(screen.getByText('No matches')).toBeTruthy()
  })
})
