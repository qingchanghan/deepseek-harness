/** Monthly calendar and per-model details for the chosen day. */
import { useMemo, useState } from 'react'
import { Button, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelUsageBucket } from '@deepseek-ai/dsh-token-meter/client'
import type { ModelPricing } from '../../chat-settings.ts'
import { addCost, emptyCost, formatCost, type Cost } from './cost.ts'
import css from './UsagePage.module.css'

const chinaDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' })
const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

/** Model usage and its rated subtotal for one day. */
export interface UsageDay {
  cost: Cost
  rows: ModelUsageBucket[]
}

interface CalendarProps extends PropsLocale<'chat'> {
  days: ReadonlyMap<string, UsageDay>
  from: string
  through: string
  pricing: ModelPricing | undefined
}

/** Format a timestamp as the ISO calendar date in China Standard Time.
 * @param time - epoch millisecond timestamp.
 * @returns date in YYYY-MM-DD form.
 */
export function chinaDay(time: number): string {
  return chinaDate.format(time)
}

function monthStart(month: string): Date {
  return new Date(`${month}-01T00:00:00Z`)
}

function shiftMonth(month: string, distance: number): string {
  const date = monthStart(month)
  date.setUTCMonth(date.getUTCMonth() + distance)
  return date.toISOString().slice(0, 7)
}

/** Render the rate coverage alongside a subtotal when part of its usage lacks a rate.
 * @param cost - subtotal and rate coverage.
 * @param pricing - active rate list.
 * @param t - Chat translations.
 * @returns localized amount or an unavailable marker.
 */
export function pricedAmount(cost: Cost, pricing: ModelPricing | undefined, t: PropsLocale<'chat'>['t']): string {
  if (pricing === undefined || cost.pricedTokens === 0) return cost.unpricedTokens > 0 ? t('usage.unpricedShort') : '—'
  const amount = formatCost(cost.amount, pricing.currency)
  return cost.unpricedTokens > 0 ? t('usage.partial', { amount }) : amount
}

/** Show daily subtotals with month navigation and a model breakdown for the selected date.
 * @param props - filtered days, bounds, pricing, and translations.
 * @returns calendar and detail panel.
 */
export function UsageCalendar({ days, from, through, pricing, t }: CalendarProps) {
  const [monthChoice, setMonthChoice] = useState<string>()
  const [dayChoice, setDayChoice] = useState<string>()
  const sorted = useMemo(() => [...days.keys()].sort(), [days])
  const today = chinaDay(Date.now())
  const last = sorted.at(-1) ?? (through || from || today)
  const first = sorted[0] ?? (from || last)
  const minMonth = (from || first).slice(0, 7)
  const maxMonth = (through || (today > last ? today : last)).slice(0, 7)
  const month = monthChoice !== undefined && monthChoice >= minMonth && monthChoice <= maxMonth
    ? monthChoice : last.slice(0, 7)
  const allowsDate = (date: string) => date >= from && (through === '' || date <= through)
  const selected = dayChoice !== undefined && dayChoice.startsWith(month) && allowsDate(dayChoice)
    ? dayChoice : sorted.findLast(date => date.startsWith(month))
  const current = selected === undefined ? undefined : days.get(selected)
  const models = useMemo(() => {
    const byRoute = new Map<string, { provider: string | null; model: string | null; cost: Cost }>()
    for (const row of current?.rows ?? []) {
      const key = JSON.stringify([row.provider, row.model])
      const model = byRoute.get(key) ?? { provider: row.provider, model: row.model, cost: emptyCost() }
      addCost(model.cost, row, pricing)
      byRoute.set(key, model)
    }
    return [...byRoute.values()].sort((left, right) => right.cost.amount - left.cost.amount
      || (left.model ?? '').localeCompare(right.model ?? ''))
  }, [current, pricing])

  const offset = (monthStart(month).getUTCDay() + 6) % 7
  const end = monthStart(month)
  end.setUTCMonth(end.getUTCMonth() + 1, 0)
  const length = end.getUTCDate()
  const cells = Math.ceil((offset + length) / 7) * 7
  const moveMonth = (distance: number) => {
    setMonthChoice(shiftMonth(month, distance))
    setDayChoice(undefined)
  }

  return <div className={css.calendarLayout}>
    <section className={css.calendar} aria-label={t('usage.calendar')}>
      <header className={css.calendarHeader}>
        <h2><time dateTime={month}>{month}</time></h2>
        <div className={css.period}>
          <Tooltip label={t('usage.previousMonth')}>
            <Button variant="ghost" icon={<IconChevronLeftOutlineRegular />} aria-label={t('usage.previousMonth')}
              disabled={month <= minMonth} onClick={() => { moveMonth(-1) }} />
          </Tooltip>
          <Tooltip label={t('usage.nextMonth')}>
            <Button variant="ghost" icon={<IconChevronRightOutlineRegular />} aria-label={t('usage.nextMonth')}
              disabled={month >= maxMonth} onClick={() => { moveMonth(1) }} />
          </Tooltip>
        </div>
      </header>
      <div className={css.weekdays} aria-hidden>
        {weekdayKeys.map(day => <span key={day}>{t(`usage.weekday.${day}`)}</span>)}
      </div>
      <div className={css.days}>
        {Array.from({ length: cells }, (_, index) => {
          const day = index - offset + 1
          if (day < 1 || day > length) return <span key={index} className={css.blankDay} aria-hidden />
          const date = `${month}-${String(day).padStart(2, '0')}`
          const daily = days.get(date)?.cost
          const amount = daily === undefined ? undefined : pricedAmount(daily, pricing, t)
          return <button key={index} type="button" className={css.day}
            aria-label={amount === undefined ? date : `${date} · ${amount}`}
            aria-pressed={date === selected} aria-current={date === today ? 'date' : undefined}
            disabled={!allowsDate(date)} data-has-usage={daily !== undefined}
            onClick={() => { setMonthChoice(month); setDayChoice(date) }}>
            <span className={css.dayNumber}>{day}</span>
            {daily !== undefined && <span className={css.dayAmount}>
              {daily.pricedTokens === 0 || pricing === undefined ? '—' : formatCost(daily.amount, pricing.currency)}
            </span>}
          </button>
        })}
      </div>
    </section>
    <section className={css.dayDetail} aria-label={t('usage.dayDetails')}>
      <header className={css.detailHeader}>
        <h2>{t('usage.dayDetails')}</h2>
        {selected !== undefined && <time dateTime={selected}>{selected}</time>}
      </header>
      {current === undefined ? <p className={css.note}>{t(selected === undefined ? 'usage.selectDay' : 'usage.noDayUsage')}</p> : <>
        <div className={css.dayTotal}>
          <span>{t('usage.total')}</span>
          <strong>{pricedAmount(current.cost, pricing, t)}</strong>
        </div>
        <h3>{t('usage.modelCosts')}</h3>
        <ul className={css.modelRows}>
          {models.map(({ provider, model, cost }) => (
            <li key={JSON.stringify([provider, model])}>
              <span className={css.model}>
                {model ?? t('usage.unknownModel')}
                {provider !== null && <small>{provider}</small>}
              </span>
              <span className={css.value}>{pricedAmount(cost, pricing, t)}</span>
            </li>
          ))}
        </ul>
      </>}
    </section>
  </div>
}
