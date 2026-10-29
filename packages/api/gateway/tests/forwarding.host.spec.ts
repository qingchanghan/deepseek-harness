/** Resource routing precedes local lookup while retaining Gateway admission and stream teardown. */
import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteScope, TypertRemoteService, type RemoteAccessResource, type TypertLookup, type TypertContext, type TypertResource } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { it, expect, vi, onTestFinished } from 'vitest'
import Gateway, { type TypertRemoteTarget } from '../src/index.ts'
import { ownerPeer, peerFor } from './peer.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertResourceMap { forwardingSession: TypertResource<string> }
  interface TypertLookupMap { forwardingScope: TypertLookup<{ id: string }, string> }
  interface TypertContextMap { forwardingAgent: TypertContext<string> }
  interface PrincipalMap { forwardingGuest: { readonly kind: 'forwardingGuest' } }
}

class Files extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'forwardingFiles') }
  @Remote
  read(forwardingScope: { id: string }, path: string, signal: AbortSignal): string {
    signal.throwIfAborted()
    return `${forwardingScope.id}:${path}`
  }
  @RemoteScope('forwardingAgent')
  list(): readonly string[] { return ['local command'] }
  @Remote({ mode: 'stream' })
  async *watch(forwardingScope: { id: string }, signal: AbortSignal): AsyncGenerator<string> {
    signal.throwIfAborted()
    yield forwardingScope.id
  }
}

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway)
  await ctx.plugin(Files)
  const lookup = vi.fn((id: string) => id === 'local' ? { id } : undefined)
  const context = vi.fn((id: string) => id === 'local' ? ctx : undefined)
  ctx.typert.resources.register('forwardingSession', { field: 'sessionId' })
  ctx.typert.lookups.register('forwardingScope', {
    parameter: 'forwardingScope', wire: 'scopeId', resource: 'forwardingSession',
    hostTypeSymbol: '@fixture/forwarding#Scope', wireTypeSymbol: '@fixture/forwarding#Id', resolve: lookup,
  })
  ctx.typert.contexts.registerHost('forwardingAgent', {
    wire: 'agentId', resource: 'forwardingSession', wireTypeSymbol: '@fixture/forwarding#Id', resolve: context,
  })
  const invoke = vi.fn<TypertRemoteTarget['invoke']>(async () => 'remote file')
  const ended = vi.fn()
  const target: TypertRemoteTarget = {
    invoke,
    stream: async function* (_endpoint, _payload, signal) {
      try {
        yield 'remote update'
        if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => { resolve() }, { once: true }))
      } finally { ended() }
    },
  }
  const forward = vi.fn((resources: readonly RemoteAccessResource[]) => resources.some(resource => 'id' in resource && resource.id === 'remote') ? target : undefined)
  const plugin = ctx.plugin({ inject: ['typertGateway'], apply(scope: Context) {
    scope.effect(() => scope.typertGateway.registerForwarder(forward))
  } })
  await plugin
  const call = (method: string, args: Record<string, unknown>) => ctx.typertGateway.invoke({ namespace: 'forwardingFiles', method, args, peer: ownerPeer(ctx) })
  return { ctx, lookup, context, invoke, ended, forward, plugin, call }
}

it('routes lookup and scoped calls without activating a local Agent, and removes routing with its plugin', async () => {
  const f = await fixture()
  await expect(f.call('read', { scopeId: 'remote', path: '/data/report.md' })).resolves.toBe('remote file')
  expect(f.invoke).toHaveBeenCalledWith('forwardingFiles/read', { scopeId: 'remote', path: '/data/report.md' }, expect.any(AbortSignal))
  expect(f.lookup).not.toHaveBeenCalled()
  await expect(f.call('list', { agentId: 'remote' })).resolves.toBe('remote file')
  expect(f.context).not.toHaveBeenCalled()
  await expect(f.call('read', { scopeId: 'local', path: '/tmp/file' })).resolves.toBe('local:/tmp/file')
  await f.plugin.dispose()
  await expect(f.call('read', { scopeId: 'remote', path: '/data/report.md' })).rejects.toMatchObject({ code: 'gateway/lookup-not-found' })
})

it('rejects malformed arguments and unauthorized callers before forwarding', async () => {
  const f = await fixture()
  await expect(f.call('read', { scopeId: 'remote', path: '/data/file', extra: true })).rejects.toThrow()
  await expect(f.ctx.typertGateway.invoke({ namespace: 'forwardingFiles', method: 'read',
    args: { scopeId: 'remote', path: '/data/file' }, peer: peerFor(f.ctx, { kind: 'forwardingGuest' }),
  })).rejects.toMatchObject({ code: 'remote-access/denied' })
  expect(f.invoke).not.toHaveBeenCalled()
  expect(f.lookup).not.toHaveBeenCalled()
})

it('cancels and releases a forwarded downlink without opening a local file watcher', async () => {
  const f = await fixture()
  const controller = new AbortController()
  const stream = await f.ctx.typertGateway.stream({ namespace: 'forwardingFiles', method: 'watch',
    args: { scopeId: 'remote' }, peer: ownerPeer(f.ctx), signal: controller.signal })
  const iterator = stream[Symbol.asyncIterator]()
  expect(await iterator.next()).toMatchObject({ value: 'remote update' })
  controller.abort()
  await iterator.return?.()
  expect(f.ended).toHaveBeenCalledOnce()
  expect(f.lookup).not.toHaveBeenCalled()
})

it('does not turn an allowed guest call into a remote owner call', async () => {
  const f = await fixture()
  f.ctx.remoteAccess.registerPolicy('forwardingGuest', { bindings: () => [{
    role: { name: 'fixture-reader', resource: 'forwardingSession', actions: ['forwardingFiles/read'] },
    resource: { kind: 'forwardingSession', id: 'remote' },
  }] })
  await expect(f.ctx.typertGateway.invoke({ namespace: 'forwardingFiles', method: 'read',
    args: { scopeId: 'remote', path: '/data/file' }, peer: peerFor(f.ctx, { kind: 'forwardingGuest' }),
  })).rejects.toMatchObject({ code: 'remote-access/denied', details: { reason: 'forwarded-principal-unsupported' } })
  expect(f.invoke).not.toHaveBeenCalled()
  expect(f.lookup).not.toHaveBeenCalled()
})
