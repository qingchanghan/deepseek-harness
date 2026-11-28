/** Price reported token buckets with the current configured unit rates. */
import type { ModelUsageBucket } from '@deepseek-ai/dsh-token-meter/client'
import type { ModelPricing } from '../../chat-settings.ts'

/** Estimated amount and the coverage of the configured price list. */
export interface Cost {
  amount: number
  pricedTokens: number
  unpricedTokens: number
}

/** Make independent totals for one Session or calendar period.
 * @returns a fresh set of zero totals.
 */
export function emptyCost(): Cost {
  return { amount: 0, pricedTokens: 0, unpricedTokens: 0 }
}

/**
 * Add metered input, cache reads, cache writes, and output at their own rates.
 * @param total - running estimate to update.
 * @param row - reported provider usage.
 * @param pricing - current price list, when configured.
 */
export function addCost(total: Cost, row: ModelUsageBucket, pricing: ModelPricing | undefined): void {
  const models = row.provider !== null && pricing !== undefined && Object.hasOwn(pricing.rates, row.provider)
    ? pricing.rates[row.provider] : undefined
  const prices = row.model !== null && models !== undefined && Object.hasOwn(models, row.model)
    ? models[row.model] : undefined
  let selectedThreshold = -1
  let rate = prices
  for (const tier of prices?.tiers ?? []) {
    if (row.promptTokens > tier.abovePromptTokens && tier.abovePromptTokens > selectedThreshold) {
      rate = tier
      selectedThreshold = tier.abovePromptTokens
    }
  }
  for (const [tokens, unit] of [
    [row.uncachedInputTokens, rate?.input],
    [row.cacheReadTokens, rate?.cacheRead],
    [row.cacheWriteTokens, rate?.cacheWrite],
    [row.outputTokens, rate?.output],
  ] as const) {
    if (unit === undefined) total.unpricedTokens += tokens
    else {
      total.amount += (tokens * unit) / 1_000_000
      total.pricedTokens += tokens
    }
  }
}

/**
 * Estimate the cost of a whole Session.
 * @param rows - model-hour buckets excluding inherited usage.
 * @param pricing - current price list, when configured.
 * @returns estimated amount and rate coverage.
 */
export function estimateCost(rows: readonly ModelUsageBucket[], pricing: ModelPricing | undefined): Cost {
  const total = emptyCost()
  for (const row of rows) addCost(total, row, pricing)
  return total
}

/**
 * Display small charges without rounding them to a zero display.
 * @param amount - non-negative estimate in the configured currency.
 * @param currency - ISO 4217 code.
 * @returns formatted total with currency.
 */
export function formatCost(amount: number, currency: string): string {
  const format = new Intl.NumberFormat(undefined, {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 6,
  })
  if (amount > 0 && amount < 0.000001) return `< ${format.format(0.000001)}`
  return format.format(amount)
}
