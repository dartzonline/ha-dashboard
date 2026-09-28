import { memo, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { CalendarDays, Check, Home, Pencil, Plug, Receipt, TrendingDown, TrendingUp, Zap } from 'lucide-react'
import './EnergyView.css'
import { GlassTooltip } from './chartKit'
import { BAR_GAP, barProps, barTooltipCursor, chartMargin, gridProps, seriesColor, xAxisProps, yAxisProps } from './chartTheme'
import { PageFrame } from './ui/PageFrame'
import { EmptyState, LoadingState } from './ui/StateMessages'
import { useEnergy } from './useEnergy'
import type { HAEntity } from './types'

interface EnergyViewProps {
  entities: Map<string, HAEntity>
  ratePerKwh: number
  onSaveRate: (rate: number) => Promise<void>
}

const DAILY_TREND_DAYS = 14

function formatMoney(value: number) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
}

function daysInCurrentMonth() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
}

function shortDay(dayIso: string) {
  const [year, month, day] = dayIso.split('-').map(Number)
  if (!year || !month || !day) return dayIso
  return new Date(year, month - 1, day).toLocaleDateString([], { month: 'numeric', day: 'numeric' })
}

interface StatCard {
  label: string
  value: string
  trend?: 'up' | 'down' | 'flat'
}

interface ChartDatum {
  name: string
  kWh: number
}

const MAX_BARS = 6

function formatKWh(value: number) {
  const maximumFractionDigits = Math.abs(value) < 10 ? 2 : 1
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value)} kWh`
}

const kWhTick = (value: number | string) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(Number(value))

// EnergyView re-renders on every WebSocket frame (it receives the whole entity map); the recharts
// trees only need to when their memoised data actually changes.
const DeviceChart = memo(function DeviceChart({ data, rotateLabels }: { data: ChartDatum[]; rotateLabels: boolean }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={chartMargin} barGap={BAR_GAP} barCategoryGap="28%">
        <CartesianGrid {...gridProps} />
        <XAxis
          {...xAxisProps}
          dataKey="name"
          interval={0}
          angle={rotateLabels ? -20 : 0}
          textAnchor={rotateLabels ? 'end' : 'middle'}
          height={rotateLabels ? 42 : 24}
        />
        <YAxis {...yAxisProps} tickFormatter={kWhTick} />
        <Tooltip cursor={barTooltipCursor} content={<GlassTooltip valueFormat={(value) => formatKWh(value)} />} />
        <Bar dataKey="kWh" name="This month" fill={seriesColor(0)} {...barProps} />
      </BarChart>
    </ResponsiveContainer>
  )
})

const DailyChart = memo(function DailyChart({ data, ratePerKwh }: { data: { label: string; kWh: number; cost: number }[]; ratePerKwh: number }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={chartMargin} barGap={BAR_GAP} barCategoryGap="22%">
        <CartesianGrid {...gridProps} />
        <XAxis {...xAxisProps} dataKey="label" interval="preserveStartEnd" minTickGap={12} />
        <YAxis {...yAxisProps} tickFormatter={kWhTick} />
        <Tooltip
          cursor={barTooltipCursor}
          content={<GlassTooltip valueFormat={(value) => `${formatKWh(value)} · ${formatMoney(value * ratePerKwh)}`} />}
        />
        <Bar dataKey="kWh" name="Used" fill={seriesColor(0)} {...barProps} />
      </BarChart>
    </ResponsiveContainer>
  )
})

export function EnergyView({ entities, ratePerKwh, onSaveRate }: EnergyViewProps) {
  const { devices, wholeHome, daily, loading, isEmpty } = useEnergy(entities)
  const [editingRate, setEditingRate] = useState(false)
  const [rateDraft, setRateDraft] = useState(String(ratePerKwh))

  const totals = useMemo(() => {
    const hasYesterday = devices.some((device) => device.yesterdayKWh !== null)
    const hasThisMonth = devices.some((device) => device.thisMonthKWh !== null)
    const hasLastMonth = devices.some((device) => device.lastMonthKWh !== null)
    const yesterday = devices.reduce((sum, device) => sum + (device.yesterdayKWh ?? 0), 0)
    const thisMonth = devices.reduce((sum, device) => sum + (device.thisMonthKWh ?? 0), 0)
    const lastMonth = devices.reduce((sum, device) => sum + (device.lastMonthKWh ?? 0), 0)
    const deltaPct =
      hasThisMonth && hasLastMonth && thisMonth !== 0 && lastMonth !== 0
        ? ((thisMonth - lastMonth) / lastMonth) * 100
        : null
    return {
      yesterday: hasYesterday ? yesterday : null,
      thisMonth: hasThisMonth ? thisMonth : null,
      lastMonth: hasLastMonth ? lastMonth : null,
      deltaPct,
    }
  }, [devices])

  const stats = useMemo(() => {
    const cards: StatCard[] = []
    if (totals.yesterday !== null) cards.push({ label: 'Yesterday total', value: formatKWh(totals.yesterday) })
    if (totals.thisMonth !== null) cards.push({ label: 'This month total', value: formatKWh(totals.thisMonth) })
    if (totals.lastMonth !== null) cards.push({ label: 'Last month total', value: formatKWh(totals.lastMonth) })
    if (totals.deltaPct !== null) {
      const pct = totals.deltaPct
      cards.push({
        label: 'Month over month',
        value: `${pct > 0 ? '+' : ''}${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(pct)}%`,
        trend: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat',
      })
    }
    return cards
  }, [totals])

  /**
   * Bill so far this month. The whole-home meter is preferred when present because it already
   * includes everything the per-appliance sensors see; falling back to their sum is a floor, not
   * a whole-home figure, and the UI says so.
   */
  const bill = useMemo(() => {
    const wholeHomeMonth = wholeHome?.thisMonthKWh ?? null
    const kWh = wholeHomeMonth ?? totals.thisMonth
    if (kWh === null || !Number.isFinite(ratePerKwh)) return null

    const dayOfMonth = new Date().getDate()
    const monthLength = daysInCurrentMonth()
    const cost = kWh * ratePerKwh
    return {
      kWh,
      cost,
      // Straight-line projection from the month-to-date average; deliberately simple, and labelled
      // as an estimate rather than a forecast.
      projected: dayOfMonth > 0 ? (cost / dayOfMonth) * monthLength : cost,
      wholeHomeBased: wholeHomeMonth !== null,
      dayOfMonth,
      monthLength,
    }
  }, [ratePerKwh, totals.thisMonth, wholeHome])

  const dailyTrend = useMemo(() => daily.slice(-DAILY_TREND_DAYS).map((entry) => ({
    label: shortDay(entry.day),
    kWh: Number(entry.kWh.toFixed(2)),
    cost: entry.kWh * ratePerKwh,
  })), [daily, ratePerKwh])

  const dailyAverage = dailyTrend.length
    ? dailyTrend.reduce((sum, entry) => sum + entry.kWh, 0) / dailyTrend.length
    : null

  async function commitRate() {
    const parsed = Number(rateDraft)
    setEditingRate(false)
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed === ratePerKwh) {
      setRateDraft(String(ratePerKwh))
      return
    }
    try {
      await onSaveRate(parsed)
    } catch {
      setRateDraft(String(ratePerKwh))
    }
  }

  const chartData = useMemo((): ChartDatum[] => {
    const sorted = [...devices].sort((a, b) => b.currentPeriodKWh - a.currentPeriodKWh)
    if (sorted.length <= MAX_BARS) return sorted.map((device) => ({ name: device.name, kWh: device.currentPeriodKWh }))
    const top = sorted.slice(0, MAX_BARS - 1)
    const rest = sorted.slice(MAX_BARS - 1)
    const otherTotal = rest.reduce((sum, device) => sum + device.currentPeriodKWh, 0)
    return [...top.map((device) => ({ name: device.name, kWh: device.currentPeriodKWh })), { name: 'Other', kWh: otherTotal }]
  }, [devices])

  if (isEmpty) {
    return (
      <section className="energy-view" aria-label="Energy usage">
        <PageFrame icon={<Zap />} title="Energy usage" meta="No sensors found" />
        <EmptyState
          icon={<Plug />}
          title="No energy sensors found yet"
          hint="Looks for sensor.* entities with device_class: energy (kWh or Wh), such as *_energy_today, *_energy_this_month or a lifetime meter."
        />
      </section>
    )
  }

  const rotateLabels = chartData.length > 4

  return (
    <section className="energy-view" aria-label="Energy usage">
      <PageFrame
        icon={<Zap />}
        title="Energy usage"
        meta={`${devices.length} device${devices.length === 1 ? '' : 's'} tracked`}
      />

      <div className="energy-bill glass">
        <div className="energy-bill-main">
          <span className="energy-bill-icon" aria-hidden="true"><Receipt size={20} /></span>
          <div>
            <span>Estimated bill so far</span>
            <strong>{bill ? formatMoney(bill.cost) : '--'}</strong>
            <small>
              {bill
                ? `${formatKWh(bill.kWh)} this month · day ${bill.dayOfMonth} of ${bill.monthLength}${bill.wholeHomeBased ? '' : ' · tracked devices only'}`
                : 'Waiting for this month’s usage'}
            </small>
          </div>
        </div>
        <div className="energy-bill-side">
          <div>
            <span>Projected month</span>
            <strong>{bill ? formatMoney(bill.projected) : '--'}</strong>
          </div>
          <div className="energy-rate">
            <span>Rate</span>
            {editingRate ? (
              <span className="energy-rate-edit">
                <input
                  type="number"
                  step="0.001"
                  min="0"
                  autoFocus
                  value={rateDraft}
                  aria-label="Cost per kilowatt hour"
                  onChange={(event) => setRateDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void commitRate() }}
                />
                <button type="button" className="glass-pill" onClick={() => void commitRate()} title="Save rate" aria-label="Save rate"><Check size={16} /></button>
              </span>
            ) : (
              <button
                type="button"
                className="energy-rate-value"
                onClick={() => { setRateDraft(String(ratePerKwh)); setEditingRate(true) }}
                title="Edit the cost per kWh"
                aria-label={`Rate ${formatMoney(ratePerKwh)} per kWh, edit`}
              >
                <strong>{formatMoney(ratePerKwh)}</strong>
                <small>/kWh</small>
                <Pencil size={13} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>

      {stats.length > 0 && (
        <div className="energy-stats glass">
          {stats.map((stat) => (
            <div key={stat.label}>
              <span>{stat.label}</span>
              <strong>
                {stat.value}
                {stat.trend === 'up' && <TrendingUp size={13} className="trend-up" aria-label="up" />}
                {stat.trend === 'down' && <TrendingDown size={13} className="trend-down" aria-label="down" />}
              </strong>
            </div>
          ))}
        </div>
      )}

      <div className="energy-chart-row">
        <section className="energy-card glass" aria-label="Usage by device">
          <header className="energy-card-head">
            <h3><Zap size={14} aria-hidden="true" />By device · this month</h3>
          </header>
          {chartData.length ? (
            <div className="energy-chart" data-swipe-ignore>
              <DeviceChart data={chartData} rotateLabels={rotateLabels} />
            </div>
          ) : loading ? (
            <LoadingState size="compact" label="Loading usage history" />
          ) : (
            <EmptyState size="compact" icon={<Zap />} title="No device breakdown available" />
          )}
        </section>

        <section className="energy-card glass" aria-label="Daily usage trend">
          <header className="energy-card-head">
            <h3><CalendarDays size={14} aria-hidden="true" />Daily usage · last {DAILY_TREND_DAYS} days</h3>
            {dailyAverage !== null && <span>{`${formatKWh(dailyAverage)}/day · ${formatMoney(dailyAverage * ratePerKwh)}`}</span>}
          </header>
          {dailyTrend.length > 1 ? (
            <div className="energy-chart" data-swipe-ignore>
              <DailyChart data={dailyTrend} ratePerKwh={ratePerKwh} />
            </div>
          ) : loading ? (
            <LoadingState size="compact" label="Loading daily history" />
          ) : (
            <EmptyState
              size="compact"
              icon={<CalendarDays />}
              title="No daily history yet"
              hint="A cumulative energy counter or an *_energy_today sensor is needed for a daily trend."
            />
          )}
        </section>
      </div>

      {wholeHome && (
        <p className="energy-whole-home">
          <Home size={14} aria-hidden="true" />
          <span>Whole-home meter: {formatKWh(wholeHome.currentPeriodKWh)} in the last 30 days</span>
        </p>
      )}
    </section>
  )
}
