/** Remote queues share the Local control baseline and release every follower on abort or failure. */
import { expect, it, vi } from 'vitest'
import type { RemoteHostHandle } from '@deepseek-ai/dsh-api-remote-hosts'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionControlFrame } from '../src/types.ts'
import { followRemoteControls } from '../src/remote-control.ts'

const baseline = (id: string): SessionControlFrame => ({ type: 'baseline', value: { projections: {
  [id]: { asOfSeq: SessionSeq(1), values: {} },
} } })

function feed<T>(...initial: T[]) {
  const queue: T[] = [...initial]
  let wake: (() => void) | undefined
  const closed = vi.fn()
  const emitted = vi.fn()
  const push = (value: T): void => { queue.push(value); wake?.(); wake = undefined }
  async function* stream(signal: AbortSignal): AsyncGenerator<T> {
    const abort = (): void => { wake?.(); wake = undefined }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted) {
        if (queue.length > 0) { emitted(); yield queue.shift() as T }
        else await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally { signal.removeEventListener('abort', abort); closed() }
  }
  return { stream, push, closed, emitted }
}

it('publishes remote queue updates after a combined baseline and closes both sources', async () => {
  const local = feed(baseline('local'))
  const remote = feed<unknown>(baseline('remote'))
  const host: RemoteHostHandle = { id: 'h20', name: 'H20', invoke: async () => undefined,
    stream: (_endpoint, _payload, signal) => remote.stream(signal!) }
  const abort = new AbortController()
  const stream = followRemoteControls(local.stream, [host], abort.signal)
  try {
    const opening = await stream.next()
    expect(opening.value).toEqual({ type: 'baseline', value: { projections: {
      local: { asOfSeq: 1, values: {} }, remote: { asOfSeq: 1, values: {} },
    } } })
    const frame: SessionControlFrame = { type: 'projection', sessionId: SessionId('remote'), key: 'inbox', seq: 2,
      value: { 'next-turn': [{ id: 'queued', content: [{ type: 'text', text: 'followup' }] }], 'next-step': [] } }
    remote.push(frame)
    expect((await stream.next()).value).toEqual(frame)
    remote.push({ ...frame, seq: 3, value: { 'next-turn': [], 'next-step': [{ id: 'queued' }] } })
    expect((await stream.next()).value).toMatchObject({ seq: 3, value: { 'next-turn': [], 'next-step': [{ id: 'queued' }] } })
  } finally { abort.abort(); await stream.return(undefined) }
  expect(local.closed).toHaveBeenCalledOnce()
  expect(remote.closed).toHaveBeenCalledOnce()
})

it('rejects invalid remote frames and releases a blocked Local follower', async () => {
  const local = feed(baseline('local'))
  const remote = feed<unknown>({ type: 'baseline', value: { projections: { broken: { asOfSeq: 'bad' } } } })
  const host: RemoteHostHandle = { id: 'h20', name: 'H20', invoke: async () => undefined,
    stream: (_endpoint, _payload, signal) => remote.stream(signal!) }
  const stream = followRemoteControls(local.stream, [host], new AbortController().signal)
  await expect(stream.next()).rejects.toThrow()
  expect(local.closed).toHaveBeenCalledOnce()
  expect(remote.closed).toHaveBeenCalledOnce()
})

it('buffers Local updates until a slow remote baseline arrives', async () => {
  const local = feed(baseline('local'))
  const remote = feed<unknown>()
  const host: RemoteHostHandle = { id: 'h20', name: 'H20', invoke: async () => undefined,
    stream: (_endpoint, _payload, signal) => remote.stream(signal!) }
  const abort = new AbortController()
  const stream = followRemoteControls(local.stream, [host], abort.signal)
  const opening = stream.next()
  const update: SessionControlFrame = { type: 'projection', sessionId: SessionId('local'), key: 'inbox', seq: 2, value: { pending: true } }
  try {
    local.push(update)
    await vi.waitFor(() => { expect(local.emitted).toHaveBeenCalledTimes(2) })
    remote.push(baseline('remote'))
    expect((await opening).value).toMatchObject({ type: 'baseline' })
    expect((await stream.next()).value).toEqual(update)
  } finally { abort.abort(); await opening; await stream.return(undefined) }
  expect(local.closed).toHaveBeenCalledOnce()
  expect(remote.closed).toHaveBeenCalledOnce()
})

it('rejects projection updates before the remote baseline and releases both sources', async () => {
  const local = feed(baseline('local'))
  const remote = feed<unknown>({ type: 'projection', sessionId: 'remote', key: 'inbox', seq: 1, value: {} })
  const host: RemoteHostHandle = { id: 'h20', name: 'H20', invoke: async () => undefined,
    stream: (_endpoint, _payload, signal) => remote.stream(signal!) }
  const stream = followRemoteControls(local.stream, [host], new AbortController().signal)
  await expect(stream.next()).rejects.toThrow('before its baseline')
  expect(local.closed).toHaveBeenCalledOnce()
  expect(remote.closed).toHaveBeenCalledOnce()
})
