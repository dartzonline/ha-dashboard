import { useEffect, useState } from 'react'
import { Activity, Clock, Info, Sigma, TrendingUp, X } from 'lucide-react'
import {
  Area, AreaChart, CartesianGrid, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { apiUrl } from './api'
import { comfortScore, historyWindowLabel } from './insightDetails'
import type { InsightDetailConfig } from './insightDetails'
import './InsightsDetail.css'

interface InsightsDetailProps {
  config: InsightDetailConfig
  onClose: () => void
}

interface NumericPoint {
  time: number
  value: number
}

interface Transition {
  time: number
  state: string
}

interface ParsedHistory {
  numeric: NumericPoint[]
  transitions: Transition[]
}

interface ChartRow {
  time: number
  [key: string]: number
}

const tooltipStyle = { borderRadius: 10, border: '1px solid var(--border)', background: '#0d1a25', color: 'var(--text)', fontSize: 11 }
const emptyHistory: ParsedHistory = { numeric: [], transitions: [] }

function parseHistory(payload: unknown, scale = 1): ParsedHistory {
  if (!Array.isArray(payload)) return emptyHistory
  const states = Array.isArray(payload[0]) ? payload[0] : payload
  const numeric: NumericPoint[] = []
  const transitions: Transition[] = []
  let previous = ''
  states.forEach((item) => {
    if (!item || typeof item !== 'object') return
    const record = item as Record<string, unknown>
    const rawState = String(record.state ?? '')
    const time = Date.parse(String(record.last_changed ?? record.last_updated ?? ''))
    if (!Number.isFinite(time)) return
    const value = Number(rawState)
    if (Number.isFinite(value) && rawState !== '') {
      numeric.push({ time, value: value * scale })
    } else if (rawState && rawState !== previous) {
      transitions.push({ time, state: rawState })
      previous = rawState
    }
  })
  return { numeric, transitions }
}

function bucketSizeFor(hours: number) {
  if (hours <= 24) return 10 * 60_000
  if (hours <= 24 * 7) return 60 * 60_000
  return 6 * 60 * 60_000
}

function formatValue(value: number, unit: string) {
  const digits = unit === '%' || unit === 'score' ? 0 : 1
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value)}${unit && unit !== 'score' ? ` ${unit}` : ''}`
}

function formatAxisTime(timestamp: number, hours: number) {
  const date = new Date(timestamp)
  return hours <= 24
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function InsightsDetail({ config, onClose }: InsightsDetailProps) {
  const [histories, setHistories] = useState<Map<string, ParsedHistory>>(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  useEffect(() => {
    let stopped = false
    const controller = new AbortController()
    queueMicrotask(() => {
      if (!stopped) setLoading(true)
    })

    Promise.all(config.series.map(async (series) => {
      try {
        const response = await fetch(apiUrl(`history/${series.entityId}?hours=${config.hours}`), { signal: controller.signal })
        if (!response.ok) return [series.entityId, emptyHistory] as const
        return [series.entityId, parseHistory(await response.json(), series.scale ?? 1)] as const
      } catch {
        return [series.entityId, emptyHistory] as const
      }
    }))
      .then((entries) => {
        if (!stopped) setHistories(new Map(entries))
      })
      .finally(() => {
        if (!stopped) setLoading(false)
      })

    return () => {
      stopped = true
      controller.abort()
    }
  }, [config])

  const bucketSize = bucketSizeFor(config.hours)
  const buckets = new Map<number, ChartRow>()
  config.series.forEach((series, index) => {
    const key = `s${index}`
    ;(histories.get(series.entityId)?.numeric ?? []).forEach((point) => {
      const time = Math.round(point.time / bucketSize) * bucketSize
      const row = buckets.get(time) ?? { time }
      row[key] = point.value
      buckets.set(time, row)
    })
  })
  const rows = Array.from(buckets.values()).sort((left, right) => left.time - right.time)

  let chartRows = rows
  let chartKeys = config.series.map((series, index) => ({ key: `s${index}`, label: series.label, color: series.color }))

  if (config.derived === 'comfort') {
    let temperature = Number.NaN
    let humidity = Number.NaN
    chartRows = rows.flatMap((row) => {
      temperature = Number.isFinite(row.s0) ? row.s0 : temperature
      humidity = Number.isFinite(row.s1) ? row.s1 : humidity
      if (!Number.isFinite(temperature) || !Number.isFinite(humidity)) return []
      return [{ time: row.time, comfort: comfortScore(temperature, humidity) }]
    })
    chartKeys = [{ key: 'comfort', label: 'Comfort score', color: config.series[0]?.color ?? '#62d7d3' }]
  }

  const primaryKey = chartKeys[0]?.key ?? ''
  const values = chartRows.map((row) => row[primaryKey]).filter((value): value is number => Number.isFinite(value))
  const hasChart = chartRows.length > 1 && values.length > 1
  const timeline = config.series
    .flatMap((series) => histories.get(series.entityId)?.transitions ?? [])
    .sort((left, right) => right.time - left.time)
    .slice(0, 6)

  const sampleCount = config.series.reduce((total, series) => total + (histories.get(series.entityId)?.numeric.length ?? 0), 0)
  const emptyMessage = loading
    ? 'Loading recorder history'
    : config.series.length === 0
      ? 'This value is derived from live state, not a single recorded entity'
      : sampleCount === 1
        ? 'Only one recorded sample in this window, so the current value above is the latest reading'
        : 'Home Assistant recorder has no history for this entity in this window'
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN
  const trend = values.length > 1 ? values[values.length - 1] - values[0] : Number.NaN
  const ChartComponent = config.chart === 'area' ? AreaChart : LineChart

  return (
    <div className="detail-backdrop" role="presentation" onClick={onClose}>
      <section
        className="detail-sheet insight-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="insight-detail-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-handle" />
        <header>
          <span className="detail-icon"><Activity size={24} /></span>
          <div><p>{config.subtitle}</p><h2 id="insight-detail-title">{config.title}</h2></div>
          <button onClick={onClose} title="Close details" aria-label="Close details"><X size={20} /></button>
        </header>

        <div className="insight-headline">
          <div><span>Current</span><strong>{config.value}</strong></div>
          <div><span>{historyWindowLabel(config.hours)}</span><strong>{Number.isFinite(average) ? formatValue(average, config.unit) : '—'} avg</strong></div>
          <div>
            <span>Change</span>
            <strong className={Number.isFinite(trend) ? (trend > 0 ? 'up' : trend < 0 ? 'down' : '') : ''}>
              {Number.isFinite(trend) ? `${trend > 0 ? '+' : ''}${formatValue(trend, config.unit)}` : '—'}
            </strong>
          </div>
        </div>

        <div className="insight-detail-chart">
          {hasChart ? (
            <ResponsiveContainer width="100%" height="100%">
              <ChartComponent data={chartRows} margin={{ top: 8, right: 10, left: -16, bottom: 0 }}>
                <defs>
                  {chartKeys.map((item) => (
                    <linearGradient key={item.key} id={`detailFill-${item.key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={item.color} stopOpacity={.4} />
                      <stop offset="95%" stopColor={item.color} stopOpacity={.02} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid stroke="rgba(100,145,165,.16)" vertical={false} />
                <XAxis dataKey="time" tickFormatter={(value) => formatAxisTime(Number(value), config.hours)} tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} minTickGap={36} />
                <YAxis tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} domain={config.unit === '%' || config.unit === 'score' ? [0, 100] : ['auto', 'auto']} />
                <Tooltip contentStyle={tooltipStyle} labelFormatter={(label) => new Date(Number(label)).toLocaleString()} formatter={(value) => formatValue(Number(value), config.unit)} />
                {chartKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 10 }} />}
                {chartKeys.map((item) => config.chart === 'area'
                  ? <Area key={item.key} type="monotone" dataKey={item.key} name={item.label} stroke={item.color} fill={`url(#detailFill-${item.key})`} strokeWidth={2} connectNulls />
                  : <Line key={item.key} type="monotone" dataKey={item.key} name={item.label} stroke={item.color} strokeWidth={2} dot={false} connectNulls />)}
              </ChartComponent>
            </ResponsiveContainer>
          ) : timeline.length ? (
            <ul className="state-timeline">
              {timeline.map((item) => (
                <li key={`${item.time}-${item.state}`}>
                  <Clock size={14} />
                  <strong>{item.state.replaceAll('_', ' ')}</strong>
                  <small>{new Date(item.time).toLocaleString()}</small>
                </li>
              ))}
            </ul>
          ) : (
            <div className={`chart-empty ${loading ? 'is-loading' : ''}`}>
              <TrendingUp size={22} />
              <span>{emptyMessage}</span>
            </div>
          )}
        </div>

        <div className="insight-explainer">
          <span><Info size={16} /></span>
          <div><h3>How this is measured</h3><p>{config.explanation}</p></div>
        </div>

        <h3 className="insight-subheading"><Sigma size={15} /> Contributing values</h3>
        <div className="factor-grid">
          {config.factors.map((factor) => (
            <div key={factor.label} className={factor.tone ? `tone-${factor.tone}` : ''}>
              <span>{factor.label}</span>
              <strong>{factor.value}</strong>
              {factor.detail && <small>{factor.detail}</small>}
            </div>
          ))}
        </div>

        {config.chips && config.chips.length > 0 && (
          <>
            <h3 className="insight-subheading"><Activity size={15} /> Related entities</h3>
            <div className="insight-chip-row">
              {config.chips.map((chip) => <span key={chip.label}><em>{chip.label}</em>{chip.value}</span>)}
            </div>
          </>
        )}

        <footer>{config.series.map((series) => series.entityId).join(' · ') || 'Derived from live Home Assistant state'}</footer>
      </section>
    </div>
  )
}
