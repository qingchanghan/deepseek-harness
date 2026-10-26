/** Workspace reads use the remote baseline and release every completed or rejected stream. */
import { describe, expect, it, vi } from 'vitest'
import type { RemoteHostHandle } from '../src/index.ts'
import { addWorkspace, readWorkspaces } from '../src/workspaces.ts'

const item = { workspaceId: 'remote-ws', title: 'Remote project', path: '/remote/project' }

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
    const f = fixture({ type: 'baseline', value: { items: [item] } })
    const signal = new AbortController().signal
    expect(await readWorkspaces(f.host, signal)).toEqual({ items: [item] })
    expect(f.stream).toHaveBeenCalledExactlyOnceWith('workspace/follow', { args: {} }, signal)
    expect(f.closed).toHaveBeenCalledOnce()
  })

  it.each([
    { type: 'upsert', workspace: item },
    { type: 'baseline', value: { items: [{ ...item, workspaceId: '' }] } },
    { type: 'baseline', value: { items: [{ ...item, path: null }] } },
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
})
