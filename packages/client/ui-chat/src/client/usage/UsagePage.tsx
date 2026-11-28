/** Calendar totals across the local Host and connected remote Hosts. */
import { useMemo, useState } from 'react'
import { Button, IconGaugeOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ModelPricing } from '../../chat-settings.ts'
import { addCost, emptyCost, formatCost, type Cost } from './cost.ts'
import { chinaDay, pricedAmount, UsageCalendar, type UsageDay } from './UsageCalendar.tsx'
import { formatExactTokens } from '../chat/token-format.ts'
import css from './UsagePage.module.css'

type Period = 'day' | 'month'

/** Local price settings shared by the Session estimate and the report. */
export interface UsagePageInjected {
  hooks: { pricing: ObservableSnapshot<ModelPricing | undefined> }
}

/** Slots bind the report resource, price settings, and localized copy. */
export type UsagePageProps = PropsRuntime<'main'> & InjectFace<UsagePageInjected> & PropsLocale<'chat'>

/** Render the Usage entry with the Sidebar's requested icon size.
 * @param props - icon size provided by the Sidebar.
 * @returns the panel glyph.
 */
export function UsagePanelIcon({ size }: { size: number }) {
  return <IconGaugeOutlineRegular size={size} />
}

/** Render date-grouped estimates and make incomplete reports visible.
 * @param props - slot-bound resource, pricing, and translations.
 * @returns the report page.
 */
export function UsagePage({ useResource, usePricing, t }: UsagePageProps) {
  const pricing = usePricing(value => value)
  const [period, setPeriod] = useState<Period>('day')
  const [revision, setRevision] = useState(0)
  const [from, setFrom] = useState('')
  const [through, setThrough] = useState('')
  const rangeInvalid = from !== '' && through !== '' && from > through
  const resource = useResource<'usage-report'>(`dsh-resource://usage-report/all?revision=${revision}`)
  const report = resource.value
  const rows = report?.rows
  const { totals, days, months } = useMemo(() => {
    const totals = emptyCost()
    const days = new Map<string, UsageDay>()
    const byMonth = new Map<string, Cost>()
    for (const row of rows ?? []) {
      const day = chinaDay(row.hour)
      if (day < from || (through !== '' && day > through)) continue
      addCost(totals, row, pricing)
      const group = days.get(day) ?? { cost: emptyCost(), rows: [] }
      addCost(group.cost, row, pricing)
      group.rows.push(row)
      days.set(day, group)

      const month = day.slice(0, 7)
      const subtotal = byMonth.get(month) ?? emptyCost()
      addCost(subtotal, row, pricing)
      byMonth.set(month, subtotal)
    }
    return { totals, days, months: [...byMonth].sort(([left], [right]) => right.localeCompare(left)) }
  }, [rows, pricing, from, through])
  const peak = months.reduce((max, [, cost]) => Math.max(max, cost.amount), 0)
  const refresh = () => { setRevision(value => value + 1) }
  return <section className={css.page} data-usage-report aria-label={t('usage.page')}>
    <header className={css.header}>
      <div>
        <h1>{t('usage.page')}</h1>
        <p>{t('usage.basis')}</p>
      </div>
      <Button variant="outline" onClick={refresh} disabled={resource.status === 'loading'}>{t('usage.refresh')}</Button>
    </header>
    {resource.status === 'loading' && !report && <div className={css.center}><StateDot state="ongoing" size={24} /></div>}
    {resource.status === 'failed' && <p role="alert">{t('usage.failed')}</p>}
    {report && <div className={css.report}>
      <div className={css.range} role="group" aria-label={t('usage.dateRange')}>
        <label>
          <span>{t('usage.startDate')}</span>
          <input type="date" value={from} max="9999-12-31" aria-invalid={rangeInvalid}
            onChange={(event) => { if (event.target.validity.valid) setFrom(event.target.value) }}
          />
        </label>
        <label>
          <span>{t('usage.endDate')}</span>
          <input type="date" value={through} max="9999-12-31" aria-invalid={rangeInvalid}
            onChange={(event) => { if (event.target.validity.valid) setThrough(event.target.value) }}
          />
        </label>
        <Button variant="ghost" disabled={from === '' && through === ''} onClick={() => { setFrom(''); setThrough('') }}>
          {t('usage.allDates')}
        </Button>
      </div>
      {rangeInvalid ? <p role="alert" className={css.note}>{t('usage.invalidRange')}</p> : <>
        <div className={css.summary}>
          <div>
            <span>{t('usage.total')}</span>
            <strong>{pricing !== undefined && totals.pricedTokens > 0 ? formatCost(totals.amount, pricing.currency) : '—'}</strong>
          </div>
          <div className={css.period} role="group" aria-label={t('usage.period')}>
            <Button variant={period === 'day' ? 'primary' : 'outline'} aria-pressed={period === 'day'} onClick={() => { setPeriod('day') }}>{t('usage.daily')}</Button>
            <Button variant={period === 'month' ? 'primary' : 'outline'} aria-pressed={period === 'month'} onClick={() => { setPeriod('month') }}>{t('usage.monthly')}</Button>
          </div>
        </div>
        {!pricing && <p className={css.note}>{t('usage.noRates')}</p>}
        {totals.unpricedTokens > 0 && <p className={css.note}>{t('usage.unpriced', { tokens: formatExactTokens(totals.unpricedTokens, t) })}</p>}
        {(report.missingSessions > 0 || report.unavailableHosts > 0) && (
          <p className={css.note} role="status">{t('usage.incomplete', {
            sessions: report.missingSessions, hosts: report.unavailableHosts,
          })}</p>
        )}
        {period === 'day' ? <UsageCalendar days={days} from={from} through={through} pricing={pricing} t={t} />
          : months.length === 0 ? <p className={css.note}>{t('usage.empty')}</p> : (
            <ul className={css.rows}>
              {months.map(([date, cost]) => <li key={date} className={css.row}>
                <time dateTime={date}>{date}</time>
                <span className={css.barTrack} aria-hidden>
                  <span className={css.bar} style={{ width: `${peak === 0 ? 0 : cost.amount * 100 / peak}%` }} />
                </span>
                <span className={css.value}>{pricedAmount(cost, pricing, t)}</span>
              </li>)}
            </ul>
          )}
      </>}
    </div>}
  </section>
}
