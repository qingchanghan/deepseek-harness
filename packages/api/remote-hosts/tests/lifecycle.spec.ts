/** Remote connection lifecycle with only the SSH and remote-network endpoints replaced. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { WebInstanceDescriptor } from '../src/instance-descriptor.ts'
import type { Tunnel } from '../src/ssh.ts'
import RemoteHosts from '../src/index.ts'

const transport = vi.hoisted(() => ({ discover: vi.fn(), tunnel: vi.fn(), invoke: vi.fn(), close: vi.fn() }))
vi.mock('../src/ssh.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/ssh.ts')>(),
  listRemoteInstances: transport.discover, openTunnel: transport.tunnel,
}))
vi.mock('../src/remote-client.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/remote-client.ts')>(),
  RemoteHostClient: class {
    invoke = transport.invoke
    close = transport.close
    async *stream(_endpoint: string, _payload: object, signal: AbortSignal): AsyncIterable<unknown> {
      if (signal.aborted) return
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    }
  },
}))

const descriptor: WebInstanceDescriptor = {
  version: 1, pid: 1, startedAt: '2026-10-26T00:00:00.000Z', protocol: 'http:', host: '127.0.0.1', port: 12345,
  url: 'http://127.0.0.1:12345/?token=fixture', home: '/fixture',
}

/** Mount the ordinary service through Cordis so schema and effect ownership stay real. */
async function host(): Promise<RemoteHosts> {
  transport.discover.mockReset().mockResolvedValue([descriptor])
  transport.tunnel.mockReset().mockResolvedValue({ port: 12345, close: vi.fn(async () => {}) })
  transport.invoke.mockReset().mockResolvedValue({ items: [] })
  transport.close.mockReset()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(RemoteHosts, { hosts: [{ id: 'h20', name: 'H20', sshTarget: 'fixture' }], connectOnStart: false })
  return ctx.remoteHosts
}

describe('SSH host lifecycle', () => {
  it('keeps configured hosts visible before connecting and after disconnecting', async () => {
    const service = await host()
    expect(service.describe().hosts).toEqual([expect.objectContaining({ id: 'h20', status: 'idle', sshTarget: 'fixture' })])
    await service.connect('h20')
    expect(service.list()[0]?.status).toBe('connected')
    await service.disconnect('h20')
    expect(service.list()[0]?.status).toBe('idle')
    expect(transport.close).toHaveBeenCalledOnce()
    expect(transport.tunnel.mock.results[0]?.value).toBeDefined()
  })

  it('reports discovery failures without losing saved connection fields', async () => {
    const service = await host()
    transport.discover.mockRejectedValueOnce(new Error('SSH connection refused'))
    await service.connect('h20')
    expect(service.list()[0]).toMatchObject({ status: 'error', sshTarget: 'fixture', error: 'SSH connection refused' })
    await service.disconnect('h20')
    expect(service.list()[0]).toMatchObject({ status: 'idle' })
  })

  it('does not attach after a disconnect overtakes discovery', async () => {
    const service = await host()
    const pending = Promise.withResolvers<WebInstanceDescriptor[]>()
    transport.discover.mockReturnValueOnce(pending.promise)
    const connecting = service.connect('h20')
    await vi.waitFor(() =>{  expect(transport.discover).toHaveBeenCalledOnce() })
    const disconnected = service.disconnect('h20')
    pending.resolve([descriptor])
    await Promise.all([connecting, disconnected])
    expect(service.list()[0]?.status).toBe('idle')
    expect(transport.tunnel).not.toHaveBeenCalled()
  })

  it('closes a tunnel that becomes ready after a disconnect', async () => {
    const service = await host()
    const pending = Promise.withResolvers<Tunnel>()
    const close = vi.fn(async () => {})
    transport.tunnel.mockReturnValueOnce(pending.promise)
    const connecting = service.connect('h20')
    await vi.waitFor(() =>{  expect(transport.tunnel).toHaveBeenCalledOnce() })
    const disconnected = service.disconnect('h20')
    pending.resolve({ port: 12345, close })
    await Promise.all([connecting, disconnected])
    expect(close).toHaveBeenCalledOnce()
    expect(service.list()[0]?.status).toBe('idle')
    expect(transport.invoke).not.toHaveBeenCalled()
  })

  it('rejects edits for a service without a writable profile entry', async () => {
    const service = await host()
    await expect(service.setHosts({ hosts: [], expectedRevision: 0 })).rejects.toMatchObject({ code: 'remote-hosts/configuration-rejected' })
    await expect(service.reconnect('missing')).rejects.toMatchObject({ code: 'remote-hosts/not-found' })
  })
})
