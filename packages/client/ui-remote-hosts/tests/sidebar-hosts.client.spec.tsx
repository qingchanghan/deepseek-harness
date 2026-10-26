// @vitest-environment jsdom
/** Direct sidebar navigation and connection states without mounting the Hosts page. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { RemoteHostWorkspaces } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '../src/client/workspace-resource.ts'
import { SidebarHosts, type SidebarHostsProps } from '../src/client/SidebarHosts.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

/** This component requests only remote-workspaces; the framework hook also admits other protocols. */
function resource(snapshot: ResourceSnapshot<RemoteHostWorkspaces>): SidebarHostsProps['useResource'] {
  return vi.fn(() => snapshot) as SidebarHostsProps['useResource']
}

/** Two machines with local, ordinary remote, child, and blank rows. */
function props(): SidebarHostsProps {
  const rows: SessionSummary[] = ['local', 'remote', 'child', 'blank'].map(id => ({
    id: id as SessionId, displayTitle: id, title: id, running: false, blank: id === 'blank',
    updatedAt: 1_700_000_000_000, retainedBy: id === 'remote' ? { mainView: 1 } : {},
    ...id === 'local' ? {} : { host: { id: 'h20', name: 'H20-141-sy' } },
    ...id === 'child' ? { origin: 'subagent' as const } : {},
  }))
  const list: SessionListState = {
    ids: rows.map(row => row.id), byId: Object.fromEntries(rows.map(row => [row.id, row])),
    phase: 'ready', projectionsBySession: {},
  }
  return {
    query: '', t: makeTranslate(zh),
    useSessions: selector => selector(list),
    useResource: resource({
      status: 'live', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] }, failure: undefined,
    }),
    renderFactorySlot: vi.fn<SidebarHostsProps['renderFactorySlot']>(() => null),
    useHosts: selector => selector({
      status: 'ready', error: null, notice: null,
      catalog: { writable: true, revision: 1, hosts: [{ id: 'h20', name: 'H20-141-sy', sshTarget: 'h20', status: 'connected' }] },
    }),
    openSession: vi.fn(), manageHosts: vi.fn(),
  }
}

describe('sidebar hosts', () => {
  it('delegates connected Host membership and navigation to the shared Workspace tree', () => {
    const face = props()
    render(<SidebarHosts {...face} />)
    expect(screen.getByText('H20-141-sy')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'local' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'child' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'blank' })).toBeNull()
    expect(face.useResource).toHaveBeenCalledWith('dsh-resource://remote-workspaces/h20?revision=0')
    expect(face.renderFactorySlot).toHaveBeenCalledWith('workspace.host.tree', expect.objectContaining({
      hostId: 'h20', label: 'H20-141-sy', workspaces: [], openSession: face.openSession, loading: false,
    }))
    fireEvent.click(screen.getByRole('button', { name: zh['sidebar.manage'] }))
    expect(face.manageHosts).toHaveBeenCalledOnce()
  })

  it('filters remote titles with the workspace search query', () => {
    const face = props()
    render(<SidebarHosts {...face} query="unmatched" />)
    expect(face.renderFactorySlot).toHaveBeenCalledWith('workspace.host.tree', expect.objectContaining({
      query: 'unmatched', emptyLabel: zh['sidebar.noMatches'],
    }))
  })

  it('keeps disconnected and failed hosts visible without Sessions', () => {
    const face = props()
    face.useSessions = selector => selector({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
    face.useHosts = selector => selector({
      status: 'ready', error: null, notice: null,
      catalog: { writable: true, revision: 1, hosts: [
        { id: 'h20', name: 'H20-141-sy', sshTarget: 'h20', status: 'idle' },
        { id: 'failed', name: 'Unavailable machine', sshTarget: 'failed', status: 'error', error: 'SSH connection refused' },
      ] },
    })
    render(<SidebarHosts {...face} />)
    expect(screen.getByText('H20-141-sy')).toBeDefined()
    expect(screen.getByText('Unavailable machine')).toBeDefined()
    expect(screen.getByRole('status', { name: zh['status.idle'] })).toBeDefined()
    expect(screen.getByRole('status', { name: zh['status.error'] })).toBeDefined()
    expect(face.useResource).not.toHaveBeenCalled()
    expect(face.renderFactorySlot).not.toHaveBeenCalled()
  })

  it('retains the latest membership after a stream failure and retries with a fresh resource', () => {
    const face = props()
    face.useResource = resource({
      status: 'failed', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] },
      failure: Object.assign(new Error('Lost connection'), {
        name: 'RemoteError', isDSHRemoteError: true as const, code: 'gateway/internal' as const, details: {},
      }),
    })
    render(<SidebarHosts {...face} />)
    expect(screen.getByRole('alert').textContent).toBe(zh['new.loadFailed'])
    expect(face.renderFactorySlot).toHaveBeenCalledWith('workspace.host.tree', expect.objectContaining({ loading: false }))
    fireEvent.click(screen.getByRole('button', { name: zh['panel.refresh'] }))
    expect(face.useResource).toHaveBeenLastCalledWith('dsh-resource://remote-workspaces/h20?revision=1')
  })

  it('does not invent Ungrouped membership when the first Workspace read fails', () => {
    const face = props()
    face.useResource = resource({ status: 'failed', value: undefined, failure: Object.assign(new Error('No baseline'), {
      name: 'RemoteError', isDSHRemoteError: true as const, code: 'gateway/internal' as const, details: {},
    }) })
    render(<SidebarHosts {...face} />)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(face.renderFactorySlot).not.toHaveBeenCalled()
  })
})
