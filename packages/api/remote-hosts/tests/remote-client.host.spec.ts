/** Attached Hosts share the Connection binary decoder and retain structured remote failures. */
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { RemoteHostClient } from '../src/remote-client.ts'

function client(response: (rpcId: string) => Response) {
  const target = new RemoteHostClient({ baseUrl: 'http://127.0.0.1:1234', token: 'fixture', timeoutMs: 1000,
    fetch: async (url, init) => {
      const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      if (address.includes('/connect?')) return new Response(null, { status: 302, headers: { 'set-cookie': 'fixture=owner' } })
      if (typeof init?.body !== 'string') throw new Error('fixture expects a JSON request')
      const request = z.object({ rpcId: z.string() }).parse(JSON.parse(init.body))
      expect(new Headers(init?.headers).get('cookie')).toBe('fixture=owner')
      return response(request.rpcId)
    },
  })
  onTestFinished(() => { target.close() })
  return target
}

it('restores remote file bytes before the local Gateway encodes them again', async () => {
  const target = client((rpcId) => {
    const parts = new FormData()
    parts.set('metadata', JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { data: null } },
      attachments: [{ path: ['data'], codec: 'bytes', part: 'file' }] }))
    parts.set('file', new Blob([new Uint8Array([0, 128, 255])]))
    return new Response(parts)
  })
  await expect(target.invoke('workspaceFiles/readBytes', {})).resolves.toEqual({ data: new Uint8Array([0, 128, 255]) })
})

it('preserves the remote error code and details', async () => {
  const target = client(rpcId => Response.json({ type: 'server-response', rpcId,
    result: { ok: false, error: { code: 'session/not-found', message: 'Session is absent', details: { sessionId: 'remote' } } } }))
  await expect(target.invoke('commands/list', {})).rejects.toMatchObject({
    isDSHRemoteError: true, code: 'session/not-found', details: { sessionId: 'remote' },
  })
})

it('rejects a response belonging to another request', async () => {
  const target = client(() => Response.json({ type: 'server-response', rpcId: 'unrelated', result: { ok: true, value: 'unsafe' } }))
  await expect(target.invoke('commands/list', {})).rejects.toMatchObject({ code: 'remote-host/protocol' })
})
