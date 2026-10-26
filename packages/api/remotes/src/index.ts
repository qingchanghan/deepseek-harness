/** Host BFF entry and Loader shell for the Remote contribution assembly. */

import { homedir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  TypertRemoteEventDispatch,
  TypertRemoteEventInvocation,
  TypertRemoteEventOutcome,
  TypertRemoteEventSource,
} from '@deepseek-ai/dsh-api-gateway'
import { Deque } from '@deepseek-ai/dsh-deque'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RemoteEventBridge } from '@deepseek-ai/dsh-api-gateway/types'
import type {} from '@deepseek-ai/dsh-api-gateway/types'
import { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'

// The owner packages' client-safe `./types` exports carry the cordis `Events`
// declarations for every allowlisted event. Pulling them into this face is what
// makes the shape assertion below judge real signatures rather than an empty
// event vocabulary.
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@deepseek-ai/dsh-cordis-host-runner/types'
import type {} from '@deepseek-ai/dsh-credentials/types'
import type {} from '@deepseek-ai/dsh-goal/types'
import type {} from '@deepseek-ai/dsh-llm/types'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type {} from '@deepseek-ai/dsh-permission-presets/types'
import type {} from '@deepseek-ai/dsh-settings/types'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
export type {} from '@deepseek-ai/dsh-api-session-controller/types'

export { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'
export type { ApiRemoteForwardedEvent } from './types.ts'

/** Required Host service: the Gateway owns the physical Remote stream mux. */
export const inject = ['typertGateway']

/** Host plugin body registering this application's selected Cordis event source. */
export function apply(ctx: Context): void {
  const queues = new Set<RemoteEventQueue>()
  ctx.provide('remoteEventBridge', createRemoteEventBridge(queues))
  ctx.effect(
    () => ctx.typertGateway.registerRemoteEvents(remoteEventSource(ctx, queues), { home: homedir() }),
    'api-remotes: forwarded Cordis event source',
  )
}

/**
 * Build the bridge over the live Client event queues.
 *
 * A question is pushed into every answering generation at once; the first
 * browser result settles it, and disposing the synthetic Agent Context removes
 * the Gateway's pending delivery just as a closed Session would.
 * @param queues - live forwarding queues, one per answering Client generation.
 * @returns the bridge service value.
 */
function createRemoteEventBridge(queues: Set<RemoteEventQueue>): RemoteEventBridge {
  return {
    forward(event, agentId, request) {
      if (queues.size === 0) {
        return { outcome: Promise.resolve({ kind: 'next' }), cancel: () => {} }
      }
      const owner = new Context()
      const subject = { id: agentId }
      const settled = Promise.withResolvers<TypertRemoteEventOutcome>()
      let done = false
      const settle = (outcome: TypertRemoteEventOutcome): void => {
        if (done) return
        done = true
        settled.resolve(outcome)
        void owner.fiber.dispose()
      }
      const dispatch: TypertRemoteEventInvocation = {
        event,
        request: { ...request, agent: subject },
        context: { value: owner, subject, agentId },
        resolve: settle,
        reject: () => { settle({ kind: 'next' }) },
      }
      for (const queue of queues) queue.push(dispatch)
      return {
        outcome: settled.promise,
        cancel: () => { settle({ kind: 'next' }) },
      }
    },
  }
}

/** Create the sole queue and listener set consumed by the registered Gateway. */
function remoteEventSource(ctx: Context, queues: Set<RemoteEventQueue>): TypertRemoteEventSource {
  return (signal) => {
    const queue = new RemoteEventQueue()
    queues.add(queue)
    const disposers = API_REMOTE_FORWARDED_EVENTS.map((entry) => {
      const { event, mode } = entry
      if (mode === 'emit') {
        const resources = 'resources' in entry ? entry.resources : undefined
        return ctx.on(event as never, ((...args: unknown[]) => {
          queue.push({ event, args: assertJsonArgs(event, args), ...resources === undefined ? {} : { resources } })
        }) as never)
      }
      return ctx.on(event as never, (function (
        this: unknown,
        request: object,
        next: () => unknown,
      ) {
        const carrierAgent = carrierKeyOf(this)
        if (carrierAgent === undefined) return next()
        const agent = (request as { readonly agent?: Agent }).agent
        if (agent === undefined || agent !== carrierAgent) {
          throw new TypeError(`forwarded scoped event ${JSON.stringify(event)} must carry its Agent directly`)
        }
        return forwardWaterfall(
          queue,
          event,
          request,
          { value: agent.ctx, subject: agent, agentId: agent.id },
          next,
        )
      }) as never)
    })
    return queue.iterate(signal, () => {
      queues.delete(queue)
      for (const dispose of disposers) dispose()
    })
  }
}

/** One pull-driven queue bridging synchronous Cordis listeners to an AsyncIterable. */
class RemoteEventQueue {
  private readonly buffer = new Deque<TypertRemoteEventDispatch>()
  private waiter: (() => void) | undefined
  private done = false

  push(frame: TypertRemoteEventDispatch): boolean {
    if (this.done) return false
    this.buffer.pushBack(frame)
    this.waiter?.()
    return true
  }

  private end(reason: unknown): void {
    if (this.done) return
    this.done = true
    while (this.buffer.size > 0) {
      const dispatch = this.buffer.popFront() as TypertRemoteEventDispatch
      if ('context' in dispatch) dispatch.reject(reason)
    }
    this.waiter?.()
  }

  async *iterate(signal: AbortSignal, cleanup: () => void): AsyncGenerator<TypertRemoteEventDispatch> {
    const abort = (): void => { this.end(remoteEventSourceEndReason(signal)) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        if (this.done || signal.aborted) return
        while (this.buffer.size > 0) yield this.buffer.popFront() as TypertRemoteEventDispatch
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.end(remoteEventSourceEndReason(signal))
      cleanup()
    }
  }
}

/**
 * Normalize an event-source shutdown for pending Host waterfalls.
 * @param signal - source lifetime whose reason wins after cancellation.
 * @returns the cancellation reason or an unexpected-end failure.
 */
function remoteEventSourceEndReason(signal: AbortSignal): unknown {
  if (signal.aborted) return signal.reason
  return new Error('api-remotes: forwarded Remote event source ended')
}

/** Bridge one Cordis waterfall listener through the Gateway-owned pending event. */
function forwardWaterfall(
  queue: RemoteEventQueue,
  event: string,
  request: object,
  context: TypertRemoteEventInvocation['context'],
  next: () => unknown,
): Promise<unknown> {
  const settled = Promise.withResolvers<unknown>()
  const dispatch: TypertRemoteEventInvocation = {
    event,
    request,
    context,
    resolve: (outcome: TypertRemoteEventOutcome) => {
      if (outcome.kind === 'result') {
        settled.resolve(outcome.value)
        return
      }
      void Promise.resolve().then(next).then(settled.resolve, settled.reject)
    },
    reject: settled.reject,
  }
  if (!queue.push(dispatch)) void Promise.resolve().then(next).then(settled.resolve, settled.reject)
  return settled.promise
}

/** Reject an allowlisted event whose runtime arguments are not lossless JSON data. */
function assertJsonArgs(event: string, args: readonly unknown[]): JsonValue[] {
  for (const [index, arg] of args.entries()) {
    if (!isJsonValue(arg)) {
      throw new Error(`forwarded host event "${event}" argument ${String(index)} is not lossless JSON data`)
    }
  }
  return args as JsonValue[]
}
