import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Home, Plug, TrendingDown, TrendingUp, Zap } from 'lucide-react'
import './EnergyView.css'
import { useEnergy } from './useEnergy'
import type { HAEntity } from './types'

interface EnergyViewProps {
  entities: Map<string, HAEntity>
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

export function EnergyView({ entities }: EnergyViewProps) {
  const { devices, wholeHome, loading, isEmpty } = useEnergy(entities)

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

      <div className="energy-chart">
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

      {wholeHome && (
        <div className="energy-whole-home">
          <Home size={14} />
          <span>Whole-home meter — {formatKWh(wholeHome.currentPeriodKWh)} in the last 30 days</span>
        </div>
      )}
    </section>
  )
}
