// @vitest-environment jsdom
/** Direct sidebar navigation and connection states without mounting the Hosts page. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SidebarHosts, type SidebarHostsProps } from '../src/client/SidebarHosts.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

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
    usePanelInfo: selector => selector({ activePanelId: null }),
    useHosts: selector => selector({
      status: 'ready', error: null, notice: null,
      catalog: { writable: true, revision: 1, hosts: [{ id: 'h20', name: 'H20-141-sy', sshTarget: 'h20', status: 'connected' }] },
    }),
    openSession: vi.fn(), manageHosts: vi.fn(),
  }
}

describe('sidebar hosts', () => {
  it('opens an ordinary remote Session and highlights the active conversation', () => {
    const face = props()
    render(<SidebarHosts {...face} />)
    expect(screen.getByText('H20-141-sy')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'local' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'child' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'blank' })).toBeNull()
    const row = screen.getByRole('button', { name: 'remote' })
    expect(row.getAttribute('aria-current')).toBe('page')
    fireEvent.click(row)
    expect(face.openSession).toHaveBeenCalledWith('remote')
    fireEvent.click(screen.getByRole('button', { name: zh['sidebar.manage'] }))
    expect(face.manageHosts).toHaveBeenCalledOnce()
  })

  it('filters remote titles with the workspace search query', () => {
    render(<SidebarHosts {...props()} query="unmatched" />)
    expect(screen.queryByRole('button', { name: 'remote' })).toBeNull()
    expect(screen.getByText(zh['sidebar.noMatches'])).toBeDefined()
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
  })
})
