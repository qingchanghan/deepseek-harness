/** Host-page request coalescing, revision writes, and disposal. */
import { describe, expect, it, vi } from 'vitest'
import type { RemoteHostsSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { HostsController } from '../src/client/controller.ts'
import { en, type Translate } from '../src/client/locales.ts'

const t: Translate = (key, values) => en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? ''))
const empty: RemoteHostsSnapshot = { hosts: [], writable: true, revision: 3 }

/** A typed replacement of the network namespace. */
function api() {
  return {
    describe: vi.fn(async () => ({ ok: true as const, value: empty })),
    setHosts: vi.fn(async () => ({ ok: true as const, value: empty })),
    reconnect: vi.fn(async () => ({ ok: true as const, value: empty })),
    disconnectHost: vi.fn(async () => ({ ok: true as const, value: empty })),
  } satisfies ConstructorParameters<typeof HostsController>[0]
}

describe('HostsController', () => {
  it('reads again after an invalidation during an unfinished status request', async () => {
    const remote = api()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.describe>>>()
    remote.describe.mockReturnValueOnce(pending.promise)
    const controller = new HostsController(remote, t)
    const initial = controller.load()
    void controller.load()
    pending.resolve({ ok: true, value: empty })
    await initial
    expect(remote.describe).toHaveBeenCalledTimes(2)
    expect(controller.store.getSnapshot().status).toBe('ready')
    controller.dispose()
  })

  it('saves complete connection settings at the last observed revision', async () => {
    const remote = api()
    const controller = new HostsController(remote, t)
    await controller.load()
    const entry = { id: 'h20', name: 'H20', sshTarget: 'H20-141-sy', remoteHome: '/data/.dsh' }
    expect(await controller.save(entry)).toBe(true)
    expect(remote.setHosts).toHaveBeenCalledWith({ hosts: [entry], expectedRevision: 3 })
    expect(controller.store.getSnapshot().notice?.tone).toBe('success')
    controller.dispose()
  })

  it('keeps the last good status rows after a read fails', async () => {
    const remote = api()
    const entry = { id: 'h20', name: 'H20', sshTarget: 'H20-141-sy', status: 'connected' as const }
    remote.describe.mockResolvedValueOnce({ ok: true, value: { ...empty, hosts: [entry] } })
    const controller = new HostsController(remote, t)
    await controller.load()
    remote.describe.mockRejectedValueOnce(new Error('Host unavailable'))
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', catalog: { hosts: [entry] } })
    expect(controller.store.getSnapshot().error).toContain('Host unavailable')
    controller.dispose()
  })

  it('does not publish a request that finishes after disposal', async () => {
    const remote = api()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.describe>>>()
    remote.describe.mockReturnValueOnce(pending.promise)
    const controller = new HostsController(remote, t)
    const loading = controller.load()
    controller.dispose()
    const before = controller.store.getSnapshot()
    pending.resolve({ ok: true, value: empty })
    await loading
    expect(controller.store.getSnapshot()).toBe(before)
  })

  it('reports a failed save without claiming success', async () => {
    const remote = api()
    remote.setHosts.mockRejectedValueOnce(new Error('Profile changed'))
    const controller = new HostsController(remote, t)
    await controller.load()
    expect(await controller.save({ id: 'h20', sshTarget: 'H20-141-sy' })).toBe(false)
    expect(controller.store.getSnapshot().notice).toMatchObject({ tone: 'error' })
    expect(controller.store.getSnapshot().notice?.text).toContain('Profile changed')
    controller.dispose()
  })
})
