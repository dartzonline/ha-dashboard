import { useEffect, useState } from 'react'
import { Activity, TrendingUp } from 'lucide-react'
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { GlassTooltip } from './chartKit'
import { chartMargin, gridProps, lineProps, seriesColor, tooltipCursor, xAxisProps, yAxisProps } from './chartTheme'
import { EmptyState, LoadingState } from './ui/StateMessages'
import './EntityHistory.css'
import { isAbortError } from './cachedFetch'
import { downsample, fetchHistory, parseHistoryStates } from './history'
import type { HistoryPoint } from './history'
import { displayUnit, toMbps } from './units'

/** Detail sheets are opened by hand; a chart a few minutes old is indistinguishable from a fresh one. */
const HISTORY_TTL_MS = 5 * 60_000
const MAX_POINTS = 360

interface EntityHistoryProps {
  entityId: string
  unit: string
  currentState: string
}

function normalizeValue(value: number, unit: string) {
  return toMbps(value, unit)
}

function formatValue(value: number, unit: string) {
  const maximumFractionDigits = unit === '%' ? 0 : 1
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value)
  return `${formatted}${displayUnit(unit) ? ` ${displayUnit(unit)}` : ''}`
}

function parseHistory(payload: unknown, unit: string): HistoryPoint[] {
  const points = parseHistoryStates(payload).map((point) => ({ time: point.time, value: normalizeValue(point.value, unit) }))
  return downsample(points, MAX_POINTS)
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function EntityHistory({ entityId, unit, currentState }: EntityHistoryProps) {
  const [points, setPoints] = useState<HistoryPoint[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const abort = new AbortController()
    fetchHistory(entityId, 24, HISTORY_TTL_MS, abort.signal)
      .then((payload) => {
        setPoints(parseHistory(payload, unit))
        setLoading(false)
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return
        setPoints([])
        setLoading(false)
      })
    return () => abort.abort()
  }, [entityId, unit])

  const values = points.map((point) => point.value)
  const current = normalizeValue(Number(currentState), unit)
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : current
  const minimum = values.length ? Math.min(...values) : current
  const maximum = values.length ? Math.max(...values) : current

  return (
    <section className="entity-history" aria-label="24 hour history">
      <header><div><Activity size={17} /><h3>24-hour history</h3></div><span>{points.length ? `${points.length} samples` : ''}</span></header>
      <div className="history-chart glass-inset">
        {points.length > 1 ? (
          <div className="history-plot" data-swipe-ignore>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points} margin={chartMargin}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="time" {...xAxisProps} tickFormatter={formatTime} minTickGap={44} />
                <YAxis {...yAxisProps} tickFormatter={(value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} width={48} domain={['auto', 'auto']} />
                <Tooltip cursor={tooltipCursor} content={<GlassTooltip valueFormat={(value) => formatValue(value, unit)} labelFormat={(label) => formatTime(Number(label))} />} />
                <Area type="monotone" dataKey="value" name="Value" stroke={seriesColor(0)} fill={seriesColor(0)} fillOpacity={0.1} {...lineProps} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : loading ? (
          <LoadingState size="compact" label="Loading history" />
        ) : (
          <EmptyState size="compact" icon={<TrendingUp />} title="No numeric history" hint="The recorder has no numeric samples for this entity in the last 24 hours" />
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
