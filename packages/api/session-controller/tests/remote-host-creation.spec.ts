/** Remote creation publishes routing before a catalog refresh can discover the Session. */
import { Context } from '@deepseek-ai/cordis'
import RemoteHosts from '@deepseek-ai/dsh-api-remote-hosts'
import type { RemoteHostHandle } from '@deepseek-ai/dsh-api-remote-hosts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteSessionDirectory } from '../src/remote-hosts.ts'

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const invoke = vi.fn<RemoteHostHandle['invoke']>(async () => ({ sessionId: SessionId('remote-new') }))
  const host: RemoteHostHandle = { id: 'h20', name: 'H20', invoke, stream: async function* () { yield undefined } }
  const connected = vi.fn(() => [host])
  await ctx.plugin(RemoteHosts, { hosts: [], connectOnStart: false })
  vi.spyOn(ctx.remoteHosts, 'connected').mockImplementation(connected)
  return { directory: new RemoteSessionDirectory(ctx), host, invoke, connected }
}

describe('remote Session creation', () => {
  it('routes the first follow immediately and strips the local attachment id from the remote request', async () => {
    const f = await fixture()
    const pending = Promise.withResolvers<unknown>()
    f.invoke.mockReturnValueOnce(pending.promise)
    const request = { hostId: 'h20', workspaceId: 'remote-ws' as WorkspaceId }
    const creating = f.directory.create(request)
    expect(f.directory.hostOf(SessionId('remote-new'))).toBeUndefined()
    pending.resolve({ sessionId: SessionId('remote-new') })
    const value = await creating
    expect(value).toEqual({ sessionId: 'remote-new', host: { id: 'h20', name: 'H20' } })
    expect(f.directory.hostOf(value.sessionId)).toBe(f.host)
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith('session/create', { request: { workspaceId: 'remote-ws' } }, undefined)
  })

  it('refuses a disconnected Host without creating elsewhere', async () => {
    const f = await fixture()
    f.connected.mockReturnValue([])
    await expect(f.directory.create({ hostId: 'h20' })).rejects.toMatchObject({ code: 'remote-hosts/not-connected' })
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it('rejects a malformed remote creation response before recording its owner', async () => {
    const f = await fixture()
    f.invoke.mockResolvedValueOnce({ sessionId: null })
    await expect(f.directory.create({ hostId: 'h20' })).rejects.toThrow()
    expect(f.directory.hostOf(SessionId('remote-new'))).toBeUndefined()
  })

  it('does not publish a remote identity after a rejected creation', async () => {
    const f = await fixture()
    f.invoke.mockRejectedValueOnce(new Error('Workspace no longer exists'))
    await expect(f.directory.create({ hostId: 'h20' })).rejects.toThrow('Workspace no longer exists')
    expect(f.directory.hostOf(SessionId('remote-new'))).toBeUndefined()
  })
})
