/** Price reported token buckets with the current configured unit rates. */
import type { ModelUsageBucket } from '@deepseek-ai/dsh-token-meter/client'
import type { ModelPricing } from '../../chat-settings.ts'

/** Estimated amount and the coverage of the configured price list. */
export interface Cost {
  amount: number
  pricedTokens: number
  unpricedTokens: number
}

/** Token categories that can have independent rates. */
export type CostCategory = 'input' | 'cacheRead' | 'cacheWrite' | 'output'

/** Session total and the cost of each token category. */
export interface SessionCost extends Cost {
  categories: Record<CostCategory, Cost>
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
 * @param categories - optional breakdown to update alongside the total.
 */
export function addCost(
  total: Cost,
  row: ModelUsageBucket,
  pricing: ModelPricing | undefined,
  categories?: SessionCost['categories'],
): void {
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
  for (const [category, tokens] of [
    ['input', row.uncachedInputTokens],
    ['cacheRead', row.cacheReadTokens],
    ['cacheWrite', row.cacheWriteTokens],
    ['output', row.outputTokens],
  ] as const) {
    const unit = rate?.[category]
    const amount = unit === undefined ? undefined : (tokens * unit) / 1_000_000
    recordCost(total, tokens, amount)
    if (categories !== undefined) recordCost(categories[category], tokens, amount)
  }
}

function recordCost(cost: Cost, tokens: number, amount: number | undefined): void {
  if (amount === undefined) cost.unpricedTokens += tokens
  else {
    cost.amount += amount
    cost.pricedTokens += tokens
  }
}

/**
 * Estimate the cost of a whole Session.
 * @param rows - model-hour buckets excluding inherited usage.
 * @param pricing - current price list, when configured.
 * @returns total and per-category amounts and rate coverage.
 */
export function estimateCost(rows: readonly ModelUsageBucket[], pricing: ModelPricing | undefined): SessionCost {
  const categories = { input: emptyCost(), cacheRead: emptyCost(), cacheWrite: emptyCost(), output: emptyCost() }
  const total = { ...emptyCost(), categories }
  for (const row of rows) addCost(total, row, pricing, categories)
  return total
}

/**
 * Display a charge rounded to two decimal places.
 * @param amount - non-negative estimate in the configured currency.
 * @param currency - ISO 4217 code.
 * @returns formatted total with currency.
 */
export function formatCost(amount: number, currency: string): string {
  const format = new Intl.NumberFormat(undefined, {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  })
  return format.format(amount)
}
