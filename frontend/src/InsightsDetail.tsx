import { useEffect, useId, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, Clock, Info, Sigma, TrendingUp, X } from 'lucide-react'
import {
  Area, AreaChart, CartesianGrid, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { ChartLegend, GlassTooltip } from './chartKit'
import { chartMargin, gridProps, lineProps, seriesColor, tooltipCursor, xAxisProps, yAxisProps } from './chartTheme'
import { fetchHistory, unwrapHistoryPayload } from './history'
import { comfortScore, historyWindowLabel } from './insightDetails'
import type { InsightDetailConfig } from './insightDetails'
import { EmptyState, LoadingState } from './ui/StateMessages'
import { useDialog } from './ui/useDialog'
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

const emptyHistory: ParsedHistory = { numeric: [], transitions: [] }
/** Sheets are opened by hand and share their cache with the tiles and Insights panels behind them. */
const HISTORY_TTL_MS = 5 * 60_000

function parseHistory(payload: unknown, scale = 1): ParsedHistory {
  const numeric: NumericPoint[] = []
  const transitions: Transition[] = []
  let previous = ''
  unwrapHistoryPayload(payload).forEach((record) => {
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

/** Recorder states are raw slugs ("spin_cycle"); sentence-case them here rather than with CSS. */
function sentenceCase(state: string) {
  const text = state.replaceAll('_', ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
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

  const sheetRef = useDialog<HTMLElement>({ onClose })
  const titleId = useId()

  useEffect(() => {
    let stopped = false
    const controller = new AbortController()
    queueMicrotask(() => {
      if (!stopped) setLoading(true)
    })

    Promise.all(config.series.map(async (series) => {
      try {
        const payload = await fetchHistory(series.entityId, config.hours, HISTORY_TTL_MS, controller.signal)
        return [series.entityId, parseHistory(payload, series.scale ?? 1)] as const
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
  // Paint by position, not by the tile's own colour: every sheet then uses the same --chart-n order
  // as the charts behind it, whatever hue the tile config happened to carry.
  let chartKeys = config.series.map((series, index) => ({ key: `s${index}`, label: series.label, color: seriesColor(index) }))

  if (config.derived === 'comfort') {
    let temperature = Number.NaN
    let humidity = Number.NaN
    const comfortRows: ChartRow[] = []
    for (const row of rows) {
      temperature = Number.isFinite(row.s0) ? row.s0 : temperature
      humidity = Number.isFinite(row.s1) ? row.s1 : humidity
      if (Number.isFinite(temperature) && Number.isFinite(humidity)) comfortRows.push({ time: row.time, comfort: comfortScore(temperature, humidity) })
    }
    chartRows = comfortRows
    chartKeys = [{ key: 'comfort', label: 'Comfort score', color: seriesColor(0) }]
  }

  const primaryKey = chartKeys[0]?.key ?? ''
  const values = chartRows.map((row) => row[primaryKey]).filter((value): value is number => Number.isFinite(value))
  const hasChart = chartRows.length > 1 && values.length > 1
  const timeline = config.series
    .flatMap((series) => histories.get(series.entityId)?.transitions ?? [])
    .sort((left, right) => right.time - left.time)
    .slice(0, 6)

  const sampleCount = config.series.reduce((total, series) => total + (histories.get(series.entityId)?.numeric.length ?? 0), 0)
  const emptyMessage = config.series.length === 0
      ? 'This value is derived from live state, not a single recorded entity'
      : sampleCount === 1
        ? 'Only one recorded sample in this window, so the current value above is the latest reading'
        : 'Home Assistant recorder has no history for this entity in this window'
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN
  const trend = values.length > 1 ? values[values.length - 1] - values[0] : Number.NaN
  const ChartComponent = config.chart === 'area' ? AreaChart : LineChart

  const latest = (key: string) => {
    for (let index = chartRows.length - 1; index >= 0; index -= 1) {
      if (Number.isFinite(chartRows[index][key])) return formatValue(chartRows[index][key], config.unit)
    }
    return undefined
  }

  return (
    <div className="detail-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={sheetRef}
        className="detail-sheet insight-sheet glass-strong"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-handle" aria-hidden="true" />
        <header>
          <span className="detail-icon" aria-hidden="true"><Activity size={24} /></span>
          <div><p>{config.subtitle}</p><h2 id={titleId}>{config.title}</h2></div>
          <button type="button" className="glass-pill" data-autofocus onClick={onClose} title="Close details" aria-label="Close details"><X size={20} aria-hidden="true" /></button>
        </header>

        <div className="insight-headline">
          <div><span>Current</span><strong>{config.value}</strong></div>
          <div><span>{historyWindowLabel(config.hours)}</span><strong>{Number.isFinite(average) ? formatValue(average, config.unit) : '—'} avg</strong></div>
          <div>
            <span>Change</span>
            <strong>
              {Number.isFinite(trend) ? `${trend > 0 ? '+' : ''}${formatValue(trend, config.unit)}` : '—'}
            </strong>
          </div>
        </div>

        <div className="insight-detail-chart glass-inset">
          {hasChart ? (
            <>
              <ChartLegend items={chartKeys.map((item) => ({ label: item.label, color: item.color, value: latest(item.key) }))} />
              <div className="insight-detail-plot" data-swipe-ignore>
                <ResponsiveContainer width="100%" height="100%">
                  <ChartComponent data={chartRows} margin={chartMargin}>
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="time" {...xAxisProps} tickFormatter={(value) => formatAxisTime(Number(value), config.hours)} minTickGap={36} />
                    <YAxis {...yAxisProps} domain={config.unit === '%' || config.unit === 'score' ? [0, 100] : ['auto', 'auto']} tickFormatter={(value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} />
                    <Tooltip cursor={tooltipCursor} content={<GlassTooltip labelFormat={(label) => new Date(Number(label)).toLocaleString()} valueFormat={(value) => formatValue(value, config.unit)} />} />
                    {chartKeys.map((item) => config.chart === 'area'
                      ? <Area key={item.key} type="monotone" dataKey={item.key} name={item.label} stroke={item.color} fill={item.color} fillOpacity={0.1} {...lineProps} connectNulls />
                      : <Line key={item.key} type="monotone" dataKey={item.key} name={item.label} stroke={item.color} {...lineProps} connectNulls />)}
                  </ChartComponent>
                </ResponsiveContainer>
              </div>
            </>
          ) : timeline.length ? (
            <ul className="insight-transitions">
              {timeline.map((item) => (
                <li key={`${item.time}-${item.state}`}>
                  <Clock size={14} aria-hidden="true" />
                  <strong>{sentenceCase(item.state)}</strong>
                  <small>{new Date(item.time).toLocaleString()}</small>
                </li>
              ))}
            </ul>
          ) : loading ? (
            <LoadingState size="compact" label="Loading recorder history" />
          ) : (
            <EmptyState size="compact" icon={<TrendingUp />} title="No chart for this window" hint={emptyMessage} />
          )}
        </div>

        <div className="insight-explainer">
          <span aria-hidden="true"><Info size={16} /></span>
          <div><h3>How this is measured</h3><p>{config.explanation}</p></div>
        </div>

        <h3 className="insight-subheading"><Sigma size={15} aria-hidden="true" /> Contributing values</h3>
        <div className="factor-grid">
          {config.factors.map((factor) => (
            <div key={factor.label} className={factor.tone ? `is-${factor.tone}` : ''}>
              <span>
                {factor.tone === 'good' && <CheckCircle2 size={12} aria-label="OK" />}
                {(factor.tone === 'warn' || factor.tone === 'danger') && <AlertTriangle size={12} aria-label={factor.tone === 'danger' ? 'Alert' : 'Check'} />}
                {factor.label}
              </span>
              <strong>{factor.value}</strong>
              {factor.detail && <small>{factor.detail}</small>}
            </div>
          ))}
        </div>

        {config.chips && config.chips.length > 0 && (
          <>
            <h3 className="insight-subheading"><Activity size={15} aria-hidden="true" /> Related entities</h3>
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
