/** Durable, fork-safe attribution of provider tokens to the hour and model where they were incurred. */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ModelUsageBucket, TokenUsageProjection } from './projection.ts'
import { usageOf } from './usage-projection.ts'

const HOUR_MS = 3_600_000
const count = z.number().int().nonnegative()
const bucket = z.object({
  hour: z.number().int(),
  promptTokens: count,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  uncachedInputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  outputTokens: count,
})
const schema = z.object({
  ownedFrom: count,
  route: z.object({ provider: z.string(), model: z.string() }).nullable(),
  buckets: z.record(z.string(), bucket),
  last: z.object({ turn: count, step: count, key: z.string(), sample: bucket }).nullable(),
})
type ModelUsageState = z.infer<typeof schema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    modelUsage: ModelUsageState
  }
}

function adjust(
  previous: ModelUsageBucket | undefined,
  sample: ModelUsageBucket,
  sign: 1 | -1,
): ModelUsageBucket {
  return {
    hour: sample.hour,
    promptTokens: sample.promptTokens,
    provider: sample.provider,
    model: sample.model,
    uncachedInputTokens: (previous?.uncachedInputTokens ?? 0) + sign * sample.uncachedInputTokens,
    cacheReadTokens: (previous?.cacheReadTokens ?? 0) + sign * sample.cacheReadTokens,
    cacheWriteTokens: (previous?.cacheWriteTokens ?? 0) + sign * sample.cacheWriteTokens,
    outputTokens: (previous?.outputTokens ?? 0) + sign * sample.outputTokens,
  }
}

function nonempty(sample: TokenUsageProjection): boolean {
  return sample.uncachedInputTokens !== 0 || sample.cacheReadTokens !== 0
    || sample.cacheWriteTokens !== 0 || sample.outputTokens !== 0
}

/** Track each metered attempt once, including a failed attempt when a retry incurred additional usage. */
export const modelUsageProjectionDefinition = {
  key: 'modelUsage',
  stateVersion: 1,
  stateSchema: schema,
  init: (_header, inheritedEventCount) => ({ ownedFrom: inheritedEventCount, route: null, buckets: {}, last: null }),
  apply(state, event) {
    if (event.type === 'request/header') {
      const { provider, model } = event.data.header.config
      return { ...state, route: { provider, model } }
    }
    if (event.seq < state.ownedFrom) return state
    if (event.type === 'llm/retry-started' && state.last?.turn === event.data.turn && state.last.step === event.data.step) {
      return { ...state, last: null }
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
    const usage = usageOf(event)
    if (usage === undefined) return state
    const { turn, step } = event.data
    const previous = state.last?.turn === turn && state.last.step === step ? state.last : null
    const source = event.type === 'assistant/message' ? event.data.message.source : undefined
    const route = source?.kind === 'model' ? source : state.route
    const sample: ModelUsageBucket = {
      hour: previous?.sample.hour ?? Math.floor(event.time / HOUR_MS) * HOUR_MS,
      promptTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      provider: route?.provider ?? null,
      model: route?.model ?? null,
      uncachedInputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      outputTokens: usage.outputTokens,
    }
    const key = JSON.stringify([sample.hour, sample.provider, sample.model, sample.promptTokens])
    let buckets = { ...state.buckets }
    if (previous !== null) {
      const removed = adjust(buckets[previous.key], previous.sample, -1)
      if (nonempty(removed)) buckets[previous.key] = removed
      else {
        const { [previous.key]: _removed, ...remaining } = buckets
        buckets = remaining
      }
    }
    const total = adjust(buckets[key], sample, 1)
    if (nonempty(total)) buckets[key] = total
    return { ...state, buckets, last: { turn, step, key, sample } }
  },
  wire: { viewSchema: z.array(bucket), view: state => Object.values(state.buckets) },
} satisfies ProjectionDefinition<'modelUsage', ModelUsageState>
