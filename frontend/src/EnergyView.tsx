import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { CalendarDays, Check, Home, Pencil, Plug, Receipt, TrendingDown, TrendingUp, Zap } from 'lucide-react'
import './EnergyView.css'
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
      <section className="energy-view energy-view-empty" aria-label="Energy usage">
        <Plug size={28} />
        <p>No energy sensors found yet.</p>
        <span>Add a device_class: energy sensor in Home Assistant to see usage here.</span>
      </section>
    )
  }

  const rotateLabels = chartData.length > 4

  return (
    <section className="energy-view" aria-label="Energy usage">
      <header>
        <div><Zap size={17} /><h3>Energy usage</h3></div>
        <span>{devices.length} device{devices.length === 1 ? '' : 's'} tracked</span>
      </header>

      <div className="energy-bill">
        <div className="energy-bill-main">
          <span className="energy-bill-icon"><Receipt size={20} /></span>
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
                <button onClick={() => void commitRate()} title="Save rate" aria-label="Save rate"><Check size={15} /></button>
              </span>
            ) : (
              <button
                className="energy-rate-value"
                onClick={() => { setRateDraft(String(ratePerKwh)); setEditingRate(true) }}
                title="Edit the cost per kWh"
              >
                <strong>{formatMoney(ratePerKwh)}</strong>
                <small>/kWh</small>
                <Pencil size={12} />
              </button>
            )}
          </div>
        </div>
      </div>

      {stats.length > 0 && (
        <div className="energy-stats">
          {stats.map((stat) => (
            <div key={stat.label}>
              <span>{stat.label}</span>
              <strong>
                {stat.value}
                {stat.trend === 'up' && <TrendingUp size={13} className="trend-up" />}
                {stat.trend === 'down' && <TrendingDown size={13} className="trend-down" />}
              </strong>
            </div>
          ))}
        </div>
      )}

      <div className="energy-chart-row">
      <div className="energy-chart">
        <h4 className="energy-chart-title"><Zap size={14} />By device · this month</h4>
        {chartData.length ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: -25, bottom: 0 }} barCategoryGap="28%">
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 11, fill: 'var(--muted)' }}
                axisLine={false}
                tickLine={false}
                interval={0}
                angle={rotateLabels ? -20 : 0}
                textAnchor={rotateLabels ? 'end' : 'middle'}
                height={rotateLabels ? 42 : 24}
              />
              <YAxis
                tickFormatter={(value) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(Number(value))}
                tick={{ fontSize: 11, fill: 'var(--muted)' }}
                width={54}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                formatter={(value) => formatKWh(Number(value))}
                contentStyle={{ borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12 }}
                cursor={{ fill: 'var(--chart-grid)' }}
              />
              <Bar dataKey="kWh" fill="var(--chart-line)" radius={[4, 4, 0, 0]} maxBarSize={40} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className={`energy-chart-empty ${loading ? 'loading' : ''}`}>
            <Zap size={22} />
            <span>{loading ? 'Loading usage history' : 'No device breakdown available'}</span>
          </div>
        )}
      </div>

      <section className="energy-daily" aria-label="Daily usage trend">
        <header>
          <div><CalendarDays size={14} /><h4>Daily usage · last {DAILY_TREND_DAYS} days</h4></div>
          <span>{dailyAverage === null ? 'No daily history yet' : `${formatKWh(dailyAverage)}/day · ${formatMoney(dailyAverage * ratePerKwh)}`}</span>
        </header>
        <div className="energy-daily-chart">
          {dailyTrend.length > 1 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailyTrend} margin={{ top: 6, right: 6, left: -26, bottom: 0 }} barCategoryGap="22%">
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--muted)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--muted)' }} width={50} axisLine={false} tickLine={false} tickFormatter={(value) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(Number(value))} />
                <Tooltip
                  formatter={(value) => [`${formatKWh(Number(value))} · ${formatMoney(Number(value) * ratePerKwh)}`, 'Used']}
                  contentStyle={{ borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12 }}
                  cursor={{ fill: 'var(--chart-grid)' }}
                />
                <Bar dataKey="kWh" fill="var(--warn)" radius={[4, 4, 0, 0]} maxBarSize={34} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="energy-chart-empty">
              <CalendarDays size={20} />
              <span>{loading ? 'Loading daily history' : 'A cumulative energy counter is needed for a daily trend'}</span>
            </div>
          )}
        </div>
      </section>
      </div>

      {wholeHome && (
        <div className="energy-whole-home">
          <Home size={14} />
          <span>Whole-home meter — {formatKWh(wholeHome.currentPeriodKWh)} in the last 30 days</span>
        </div>
      )}
    </section>
  )
}
