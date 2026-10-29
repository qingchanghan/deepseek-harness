/** Remote connection lifecycle with only the SSH and remote-network endpoints replaced. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { WebInstanceDescriptor } from '../src/instance-descriptor.ts'
import type { Tunnel } from '../src/ssh.ts'
import RemoteHosts from '../src/index.ts'

const transport = vi.hoisted(() => ({ discover: vi.fn(), tunnel: vi.fn(), invoke: vi.fn(), close: vi.fn(), stream: vi.fn() }))
vi.mock('../src/ssh.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/ssh.ts')>(),
  listRemoteInstances: transport.discover, openTunnel: transport.tunnel,
}))
vi.mock('../src/remote-client.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/remote-client.ts')>(),
  RemoteHostClient: class {
    invoke = transport.invoke
    close = transport.close
    stream = transport.stream
  },
}))

const descriptor: WebInstanceDescriptor = {
  version: 1, pid: 1, startedAt: '2026-10-26T00:00:00.000Z', protocol: 'http:', host: '127.0.0.1', port: 12345,
  url: 'http://127.0.0.1:12345/?token=fixture', home: '/fixture',
}

/** Mount the ordinary service through Cordis so schema and effect ownership stay real. */
async function host(context = new Context()): Promise<RemoteHosts> {
  transport.discover.mockReset().mockResolvedValue([descriptor])
  transport.tunnel.mockReset().mockResolvedValue({ port: 12345, close: vi.fn(async () => {}) })
  transport.invoke.mockReset().mockResolvedValue({ items: [] })
  transport.close.mockReset()
  transport.stream.mockReset().mockImplementation(async function* (_endpoint: string, _payload: object, signal: AbortSignal) {
    yield { type: 'ready', clientId: 'fixture' }
    if (signal.aborted) return
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  })
  const ctx = context
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(RemoteHosts, { hosts: [{ id: 'h20', name: 'H20', sshTarget: 'fixture' }], connectOnStart: false })
  return ctx.remoteHosts
}

describe('SSH host lifecycle', () => {
  it('keeps backing off until the event subscription is ready', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const service = await host()
    transport.stream.mockImplementation(async function* () {
      yield { type: 'opening' }
      throw new Error('Event subscription unavailable')
    })
    await service.connect('h20')
    await vi.advanceTimersByTimeAsync(0)
    expect(service.list()[0]).toMatchObject({ status: 'error', retryAt: Date.now() + 5_000 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(service.list()[0]).toMatchObject({ status: 'error', retryAt: Date.now() + 10_000 })
  })

  it('releases a pending retry when the plugin is disposed', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const ctx = new Context()
    const service = await host(ctx)
    transport.discover.mockRejectedValue(new Error('Offline'))
    await service.connect('h20')
    expect(service.list()[0]).toHaveProperty('retryAt')
    await ctx.fiber.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(transport.discover).toHaveBeenCalledOnce()
    expect(service.list()[0]).toMatchObject({ status: 'idle' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rediscovers the remote instance after the event stream ends without an error', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const service = await host()
    transport.stream.mockImplementationOnce(async function* () {
      yield { type: 'ready', clientId: 'first' }
    })
    await service.connect('h20')
    await vi.advanceTimersByTimeAsync(0)
    expect(service.list()[0]).toMatchObject({ status: 'error', retryAt: Date.now() + 5_000 })
    expect(transport.close).toHaveBeenCalledOnce()
    transport.discover.mockResolvedValueOnce([{ ...descriptor, pid: 2, port: 23456 }])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(service.list()[0]).toMatchObject({ status: 'connected', pid: 2 })
    expect(service.list()[0]).not.toHaveProperty('retryAt')
    expect(transport.tunnel).toHaveBeenLastCalledWith(expect.anything(), { host: '127.0.0.1', port: 23456 })
  })

  it('backs off failed HTTP probes and cancels scheduled retries when manually disconnected', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const service = await host()
    transport.invoke.mockRejectedValue(new Error('Remote service unavailable'))
    await service.connect('h20')
    expect(service.list()[0]).toMatchObject({ status: 'error', retryAt: Date.now() + 5_000 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(service.list()[0]).toMatchObject({ status: 'error', retryAt: Date.now() + 10_000 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(service.list()[0]).toMatchObject({ status: 'error', retryAt: Date.now() + 20_000 })
    await service.disconnect('h20')
    expect(service.list()[0]).toMatchObject({ status: 'idle' })
    expect(service.list()[0]).not.toHaveProperty('retryAt')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(transport.discover).toHaveBeenCalledTimes(3)
    transport.invoke.mockResolvedValue({ items: [] })
    await service.connect('h20')
    expect(service.list()[0]?.status).toBe('connected')
  })

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
