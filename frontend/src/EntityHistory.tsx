import { useEffect, useState } from 'react'
import { Activity, TrendingUp } from 'lucide-react'
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import './EntityHistory.css'
import { apiUrl } from './api'

interface HistoryPoint {
  time: number
  value: number
}

interface EntityHistoryProps {
  entityId: string
  unit: string
  currentState: string
}

function normalizeValue(value: number, unit: string) {
  return unit === 'KiB/s' ? value * 8 / 1024 : value
}

function displayUnit(unit: string) {
  return unit === 'KiB/s' ? 'Mbps' : unit
}

function formatValue(value: number, unit: string) {
  const maximumFractionDigits = unit === '%' ? 0 : 1
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value)
  return `${formatted}${displayUnit(unit) ? ` ${displayUnit(unit)}` : ''}`
}

function parseHistory(payload: unknown, unit: string): HistoryPoint[] {
  if (!Array.isArray(payload)) return []
  const states = Array.isArray(payload[0]) ? payload[0] : payload
  const points = states.flatMap((item): HistoryPoint[] => {
    if (!item || typeof item !== 'object') return []
    const state = item as Record<string, unknown>
    const rawValue = Number(state.state)
    const time = Date.parse(String(state.last_changed ?? state.last_updated ?? ''))
    return Number.isFinite(rawValue) && Number.isFinite(time)
      ? [{ time, value: normalizeValue(rawValue, unit) }]
      : []
  })
  const step = Math.max(1, Math.ceil(points.length / 360))
  return points.filter((_, index) => index % step === 0 || index === points.length - 1)
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function EntityHistory({ entityId, unit, currentState }: EntityHistoryProps) {
  const [points, setPoints] = useState<HistoryPoint[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let stopped = false
    fetch(apiUrl(`history/${entityId}`))
      .then((response) => response.ok ? response.json() : [])
      .then((payload) => {
        if (!stopped) setPoints(parseHistory(payload, unit))
      })
      .catch(() => {
        if (!stopped) setPoints([])
      })
      .finally(() => {
        if (!stopped) setLoading(false)
      })
    return () => { stopped = true }
  }, [entityId, unit])

  const values = points.map((point) => point.value)
  const current = normalizeValue(Number(currentState), unit)
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : current
  const minimum = values.length ? Math.min(...values) : current
  const maximum = values.length ? Math.max(...values) : current

  return (
    <section className="entity-history" aria-label="24 hour history">
      <header><div><Activity size={17} /><h3>24-hour history</h3></div><span>{points.length ? `${points.length} samples` : ''}</span></header>
      <div className="history-chart">
        {points.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 8, right: 8, left: -25, bottom: 0 }}>
              <defs>
                <linearGradient id="entityHistoryFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--accent)" stopOpacity={.44} />
                  <stop offset="95%" stopColor="var(--accent)" stopOpacity={.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
              <XAxis dataKey="time" tickFormatter={formatTime} tick={{ fontSize: 11, fill: 'var(--muted)' }} minTickGap={44} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(value) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(Number(value))} tick={{ fontSize: 11, fill: 'var(--muted)' }} width={54} axisLine={false} tickLine={false} domain={['auto', 'auto']} />
              <Tooltip formatter={(value) => formatValue(Number(value), unit)} labelFormatter={(label) => formatTime(Number(label))} contentStyle={{ borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12 }} />
              <Area type="monotone" dataKey="value" stroke="var(--accent)" strokeWidth={3} fill="url(#entityHistoryFill)" dot={false} activeDot={{ r: 5 }} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className={`history-empty ${loading ? 'loading' : ''}`}><TrendingUp size={22} /><span>{loading ? 'Loading history' : 'No numeric history available'}</span></div>
        )}
      </div>
      <div className="history-summary">
        <div><span>Now</span><strong>{formatValue(current, unit)}</strong></div>
        <div><span>Average</span><strong>{formatValue(average, unit)}</strong></div>
        <div><span>Low</span><strong>{formatValue(minimum, unit)}</strong></div>
        <div><span>High</span><strong>{formatValue(maximum, unit)}</strong></div>
      </div>
    </section>
  )
}
