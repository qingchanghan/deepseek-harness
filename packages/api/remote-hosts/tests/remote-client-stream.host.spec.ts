/** Real socket probes detect silent peers and release timers with their client. */
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { z } from 'zod'
import { expect, it, onTestFinished, vi } from 'vitest'
import { RemoteHostClient } from '../src/remote-client.ts'

async function peer() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: false })
  onTestFinished(async () => {
    try {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    } finally { vi.useRealTimers() }
  })
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address')
  vi.useFakeTimers()
  const client = new RemoteHostClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'fixture', timeoutMs: 1000, heartbeatIntervalMs: 500,
    fetch: async () => new Response(null, { status: 302, headers: { 'set-cookie': 'fixture=owner' } }),
  })
  onTestFinished(() => { client.close() })
  const opened = Promise.withResolvers<{ socket: WebSocket; streamId: string }>()
  server.once('connection', (socket) => {
    socket.once('message', (data) => {
      if (!Buffer.isBuffer(data)) throw new Error('Expected a text frame buffer')
      const { streamId } = z.object({ type: z.literal('open'), streamId: z.string() }).parse(JSON.parse(data.toString()))
      socket.send(JSON.stringify({ type: 'item', streamId, value: { type: 'ready' } }))
      opened.resolve({ socket, streamId })
    })
  })
  const stream = client.stream('$events', { args: {} })
  expect(await stream.next()).toEqual({ done: false, value: { type: 'ready' } })
  return { client, stream, ...await opened.promise }
}

it('fails a silent socket after the configured heartbeat reply deadline', async () => {
  const { stream, socket } = await peer()
  const ping = once(socket, 'ping')
  await vi.advanceTimersByTimeAsync(500)
  await ping
  const failure = expect(stream.next()).rejects.toMatchObject({ code: 'remote-host/timeout' })
  const closed = once(socket, 'close')
  await vi.advanceTimersByTimeAsync(1000)
  await failure
  await closed
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps a responsive peer connected and removes heartbeat timers on explicit close', async () => {
  const { client, stream, socket, streamId } = await peer()
  for (let probe = 0; probe < 3; probe += 1) {
    const ping = once(socket, 'ping')
    await vi.advanceTimersByTimeAsync(500)
    await ping
    socket.pong()
    socket.send(JSON.stringify({ type: 'item', streamId, value: probe }))
    expect(await stream.next()).toEqual({ done: false, value: probe })
  }
  const closed = once(socket, 'close')
  client.close()
  await expect(stream.next()).rejects.toMatchObject({ code: 'remote-host/closed' })
  await closed
  expect(vi.getTimerCount()).toBe(0)
})
