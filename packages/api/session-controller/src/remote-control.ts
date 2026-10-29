/** Merge local and attached-Host control streams into one baseline followed by ordered projection updates. */
import { Deque } from '@deepseek-ai/dsh-deque'
import type { RemoteHostHandle } from '@deepseek-ai/dsh-api-remote-hosts'
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionControlFrame, SessionProjectionBaseline } from './types.ts'

const sequence = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER)
const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('baseline'), value: z.object({ projections: z.record(z.string().min(1), z.object({
    asOfSeq: sequence, values: z.record(z.string(), z.json()),
  })) }) }),
  z.object({ type: z.literal('projection'), sessionId: z.string().min(1), key: z.string().min(1),
    seq: sequence.min(0), value: z.json() }),
])

type Item = { readonly source: string; readonly frame: SessionControlFrame }
type Delivery = { readonly kind: 'frame'; readonly item: Item } | { readonly kind: 'error'; readonly error: unknown }

/**
 * Follow one fixed set of connected Hosts. The caller restarts after connection membership changes.
 * @param local - Local projection source factory, with one opening baseline.
 * @param hosts - Connected remote transports.
 * @param signal - Client generation lifetime.
 * @returns a complete combined baseline and later projection replacements.
 * @throws when any source closes unexpectedly or delivers an invalid control frame.
 */
export async function* followRemoteControls(
  local: (signal: AbortSignal) => AsyncIterable<SessionControlFrame>, hosts: readonly RemoteHostHandle[], signal: AbortSignal,
): AsyncGenerator<SessionControlFrame> {
  if (hosts.length === 0) { yield* local(signal); return }
  const lifetime = new AbortController()
  const combined = AbortSignal.any([signal, lifetime.signal])
  const queue = new Deque<Delivery>()
  let wake: (() => void) | undefined
  const notify = (): void => { wake?.(); wake = undefined }
  const push = (delivery: Delivery): void => { queue.pushBack(delivery); notify() }
  const baseline = new Map<string, Readonly<Record<SessionId, SessionProjectionBaseline>>>()
  const pending: Item[] = []
  const localIds = new Set<string>()
  let opened = false
  const pump = async (source: string, frames: AsyncIterable<unknown>, remote: boolean): Promise<void> => {
    try {
      for await (const raw of frames) {
        if (combined.aborted) return
        const frame = remote ? frameSchema.parse(raw) as SessionControlFrame : raw as SessionControlFrame
        push({ kind: 'frame', item: { source, frame } })
      }
      if (!combined.aborted) throw new Error(`Session control stream on ${source} ended; reconnect the Host`)
    } catch (error: unknown) {
      if (!combined.aborted) push({ kind: 'error', error })
    }
  }
  combined.addEventListener('abort', notify, { once: true })
  const tasks = [pump('Local', local(combined), false), ...hosts.map(host => pump(`remote:${host.id}`,
    host.stream('session/control', { args: {} }, combined), true))]
  try {
    while (!combined.aborted) {
      const delivery = queue.popFront()
      if (delivery === undefined) {
        await new Promise<void>((resolve) => { wake = resolve })
        continue
      }
      if (delivery.kind === 'error') throw delivery.error
      const { source, frame } = delivery.item
      if (frame.type === 'baseline') {
        if (baseline.has(source)) throw new Error(`Session control stream on ${source} repeated its baseline`)
        baseline.set(source, frame.value.projections)
        if (source === 'Local') for (const id of Object.keys(frame.value.projections)) localIds.add(id)
        if (baseline.size !== tasks.length) continue
        let projections: Readonly<Record<SessionId, SessionProjectionBaseline>> = {}
        for (const host of hosts) projections = { ...projections, ...baseline.get(`remote:${host.id}`) }
        projections = { ...projections, ...baseline.get('Local') }
        yield { type: 'baseline', value: { projections } }
        opened = true
        for (const item of pending) {
          if (item.source === 'Local' || item.frame.type === 'projection' && !localIds.has(item.frame.sessionId)) yield item.frame
        }
        pending.length = 0
      } else {
        if (!baseline.has(source)) throw new Error(`Session control stream on ${source} updated before its baseline`)
        if (source === 'Local') localIds.add(frame.sessionId)
        if (!opened) pending.push(delivery.item)
        else if (source === 'Local' || !localIds.has(frame.sessionId)) yield frame
      }
    }
  } finally {
    lifetime.abort()
    combined.removeEventListener('abort', notify)
    await Promise.allSettled(tasks)
  }
}
