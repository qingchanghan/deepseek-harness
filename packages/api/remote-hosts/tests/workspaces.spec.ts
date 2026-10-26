/** Workspace reads use the remote baseline and release every completed or rejected stream. */
import { describe, expect, it, vi } from 'vitest'
import type { RemoteHostHandle } from '../src/index.ts'
import { addWorkspace, followWorkspaces, readWorkspaces } from '../src/workspaces.ts'

const item = { workspaceId: 'remote-ws', title: 'Remote project', path: '/remote/project', sessionIds: ['session-1'],
  createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z' }
const value = { items: [item], archivedSessionIds: [], pinnedSessionIds: [] }

function fixture(frame: unknown) {
  const closed = vi.fn()
  const stream = vi.fn(async function* () {
    try { yield frame; throw new Error('A baseline read must not request increments') } finally { closed() }
  })
  const invoke = vi.fn(async () => ({ workspace: item, created: true }))
  const host: RemoteHostHandle = { id: 'h20', name: 'H20', stream, invoke }
  return { host, closed, stream, invoke }
}

describe('remote Workspaces', () => {
  it('reads the baseline without keeping a remote follower alive', async () => {
    const f = fixture({ type: 'baseline', value })
    const signal = new AbortController().signal
    expect(await readWorkspaces(f.host, signal)).toEqual(value)
    expect(f.stream).toHaveBeenCalledExactlyOnceWith('workspace/follow', { args: {} }, signal)
    expect(f.closed).toHaveBeenCalledOnce()
  })

  it.each([
    { type: 'upsert', workspace: item },
    { type: 'baseline', value: { ...value, items: [{ ...item, workspaceId: '' }] } },
    { type: 'baseline', value: { ...value, items: [{ ...item, path: null }] } },
    { type: 'baseline', value: { ...value, items: [{ ...item, sessionIds: [''] }] } },
    { type: 'baseline', value: { ...value, items: [{ ...item, createdAt: 'yesterday' }] } },
    { type: 'baseline', value: { ...value, pinnedSessionIds: null } },
  ])('rejects an invalid remote baseline and closes the stream', async (frame) => {
    const f = fixture(frame)
    await expect(readWorkspaces(f.host, new AbortController().signal)).rejects.toThrow()
    expect(f.closed).toHaveBeenCalledOnce()
  })

  it('adopts the directory on the selected Host', async () => {
    const f = fixture(null)
    expect(await addWorkspace(f.host, item.path)).toEqual(item)
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith('workspace/create', { request: { path: item.path } })
    f.invoke.mockRejectedValueOnce(new Error('Directory not found'))
    await expect(addWorkspace(f.host, '/missing')).rejects.toThrow('Directory not found')
  })

  it('streams ordered membership, rename, archive and pin changes without mutating earlier snapshots', async () => {
    const f = fixture(null)
    const second = { ...item, workspaceId: 'second', path: '/remote/second', sessionIds: [] }
    const renamed = { ...item, title: 'Renamed project', sessionIds: ['session-2'] }
    const frames = [
      { type: 'baseline', value },
      { type: 'upsert', workspace: second },
      { type: 'upsert', workspace: renamed },
      { type: 'order', workspaceIds: [second.workspaceId, item.workspaceId] },
      { type: 'archived', archivedSessionIds: ['session-2'] },
      { type: 'pinned', pinnedSessionIds: ['session-2'] },
      { type: 'remove', workspaceId: second.workspaceId },
      { type: 'replace', value },
    ]
    const abort = new AbortController()
    f.host.stream = async function* () {
      try { yield* frames } finally { f.closed() }
    }
    const snapshots = []
    for await (const snapshot of followWorkspaces(f.host, abort.signal)) {
      snapshots.push(snapshot)
      if (snapshots.length === frames.length) abort.abort()
    }
    expect(snapshots[0]).toEqual(value)
    expect(snapshots[1]?.items).toEqual([item, second])
    expect(snapshots[2]?.items).toEqual([renamed, second])
    expect(snapshots[3]?.items).toEqual([second, renamed])
    expect(snapshots[4]?.archivedSessionIds).toEqual(['session-2'])
    expect(snapshots[5]?.pinnedSessionIds).toEqual(['session-2'])
    expect(snapshots[6]?.items).toEqual([renamed])
    expect(snapshots[7]).toEqual(value)
    expect(f.closed).toHaveBeenCalledOnce()
  })

  it.each([
    { type: 'upsert', workspace: { ...item, sessionIds: false } },
    { type: 'order', workspaceIds: [null] },
    { type: 'pinned', pinnedSessionIds: [''] },
    { type: 'baseline', value },
  ])('closes a follower when a remote increment is invalid', async (frame) => {
    const f = fixture(null)
    f.host.stream = async function* () {
      try { yield { type: 'baseline', value }; yield frame } finally { f.closed() }
    }
    const iterator = followWorkspaces(f.host, new AbortController().signal)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual(value)
    await expect(iterator.next()).rejects.toThrow()
    expect(f.closed).toHaveBeenCalledOnce()
  })

  it('reports an unexpected remote stream end', async () => {
    const f = fixture(null)
    f.host.stream = async function* () { yield { type: 'baseline', value } }
    const iterator = followWorkspaces(f.host, new AbortController().signal)[Symbol.asyncIterator]()
    await iterator.next()
    await expect(iterator.next()).rejects.toThrow('closed its Workspace stream unexpectedly')
  })
})
