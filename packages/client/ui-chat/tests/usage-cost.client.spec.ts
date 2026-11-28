/** Model-use estimates cover context tiers, cache prices, and missing rates. */
import { describe, expect, it } from 'vitest'
import type { ModelUsageBucket } from '@deepseek-ai/dsh-token-meter/client'
import type { ModelPricing } from '../src/chat-settings.ts'
import { estimateCost } from '../src/client/usage/cost.ts'

const pricing: ModelPricing = {
  currency: 'CNY',
  rates: {
    gateway: {
      model: {
        input: 20, cacheRead: 2, output: 60,
        tiers: [{ abovePromptTokens: 272_000, input: 40, cacheRead: 4, cacheWrite: 50, output: 100 }],
      },
    },
  },
}
const bucket: ModelUsageBucket = {
  provider: 'gateway', model: 'model', hour: 0, promptTokens: 272_000,
  uncachedInputTokens: 100_000, cacheReadTokens: 170_000, cacheWriteTokens: 2_000, outputTokens: 25_000,
}

describe('Session cost estimates', () => {
  it('uses the applicable tier per request and accounts for all pricing categories', () => {
    const result = estimateCost([bucket, { ...bucket, promptTokens: 272_001, cacheWriteTokens: 2_001 }], pricing)
    expect(result.amount).toBeCloseTo(11.12005)
    expect(result.pricedTokens).toBe(592_001)
    expect(result.unpricedTokens).toBe(2_000)
  })

  it('does not count an unpriced route as free', () => {
    const result = estimateCost([{ ...bucket, provider: 'unpriced' }], pricing)
    expect(result).toEqual({ amount: 0, pricedTokens: 0, unpricedTokens: 297_000 })
  })
})
