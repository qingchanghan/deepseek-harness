// @vitest-environment jsdom
/** Host grouping and navigation in the Hosts panel. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { hostGroups, HostsPanelView, type HostsPanelViewProps, type Translate } from '../src/client/HostsPanel.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh) as Translate

/** One catalog row with the fields the panel reads. */
function row(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: id as SessionId,
    displayTitle: id,
    title: id,
    running: false,
    blank: false,
    updatedAt: 1_700_000_000_000,
    retainedBy: {},
    ...over,
  }
}

/** A catalog state holding exactly the given rows. */
function state(rows: readonly SessionSummary[]): SessionListState {
  const byId: Record<string, SessionSummary> = {}
  for (const entry of rows) byId[entry.id] = entry
  return { ids: rows.map(entry => entry.id), byId, phase: 'ready', projectionsBySession: {} }
}

/** A page face with a writable connection catalog. */
function face(): Omit<HostsPanelViewProps, 'groups' | 't'> {
  return {
    state: { status: 'ready', catalog: { hosts: [], writable: true, revision: 0 }, error: null, notice: null },
    actions: {
      openSession: vi.fn(), saveHost: vi.fn(async () => true), removeHost: vi.fn(async () => true),
      reconnectHost: vi.fn(async () => true), disconnectHost: vi.fn(async () => true),
      refreshHosts: vi.fn(), dismissNotice: vi.fn(),
    },
  }
}

describe('HostsPanel', () => {
  it('groups local rows first and each attached host after it', () => {
    const groups = hostGroups(state([
      row('local-a'),
      row('remote-a', { host: { id: 'h20', name: 'H20-141-sy' } }),
      row('local-b'),
      row('remote-b', { host: { id: 'h20', name: 'H20-141-sy' } }),
    ]), t)
    render(<HostsPanelView groups={groups} {...face()} t={t} />)
    const sections = screen.getAllByRole('region')
    expect(sections.map(section => section.getAttribute('aria-label'))).toEqual(['Local', 'H20-141-sy'])
    expect(screen.getAllByRole('button')).toHaveLength(6)
  })

  it('opens the clicked Session through the injected navigation action', () => {
    const openSession = vi.fn()
    const groups = hostGroups(state([
      row('remote-a', { host: { id: 'h20', name: 'H20-141-sy' } }),
    ]), t)
    render(<HostsPanelView groups={groups} {...face()} actions={{ ...face().actions, openSession }} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /remote-a/ }))
    expect(openSession).toHaveBeenCalledWith('remote-a')
  })

  it('hides subagent children and blank rows', () => {
    const groups = hostGroups(state([
      row('child', { origin: 'subagent' }),
      row('blank', { blank: true }),
    ]), t)
    render(<HostsPanelView groups={groups} {...face()} t={t} />)
    expect(screen.getByText(zh['panel.empty'])).toBeDefined()
  })
})

describe('Hosts connection editor', () => {
  it('shows a configured host even before it has Sessions', () => {
    const host = { id: 'h20', name: 'H20', sshTarget: 'H20-141-sy', status: 'error' as const, error: 'SSH connection refused' }
    const data = face()
    data.state.catalog = { ...data.state.catalog, hosts: [host] }
    render(<HostsPanelView groups={hostGroups(state([]), t, [host])} {...data} t={t} />)
    expect(screen.getByRole('region', { name: 'H20' })).toBeDefined()
    expect(screen.getByRole('status').textContent).toBe(zh['status.error'])
    expect(screen.getByRole('alert').textContent).toBe('SSH connection refused')
    expect(screen.getByRole('button', { name: zh['host.reconnect'] })).toBeDefined()
  })

  it('saves a new SSH connection through the visible dialog', async () => {
    const data = face()
    render(<HostsPanelView groups={[]} {...data} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh['panel.add'] }))
    fireEvent.change(screen.getByRole('textbox', { name: zh['editor.name'] }), { target: { value: 'H20' } })
    fireEvent.change(screen.getByRole('textbox', { name: new RegExp(zh['editor.target']) }), { target: { value: 'H20-141-sy' } })
    fireEvent.click(screen.getByRole('button', { name: zh['editor.save'] }))
    await vi.waitFor(() => { expect(data.actions.saveHost).toHaveBeenCalledWith(expect.objectContaining({ name: 'H20', sshTarget: 'H20-141-sy' }), 0) })
    await vi.waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('keeps the connection draft when saving fails', async () => {
    const data = face()
    data.actions.saveHost = vi.fn(async () => false)
    render(<HostsPanelView groups={[]} {...data} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh['panel.add'] }))
    fireEvent.change(screen.getByRole('textbox', { name: new RegExp(zh['editor.target']) }), { target: { value: 'H20-141-sy' } })
    fireEvent.click(screen.getByRole('button', { name: zh['editor.save'] }))
    await vi.waitFor(() => { expect(data.actions.saveHost).toHaveBeenCalledOnce() })
    expect(screen.getByRole('dialog')).toBeDefined()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: new RegExp(zh['editor.target']) }).value).toBe('H20-141-sy')
  })
})
