import { memo, useEffect, useState } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { isAbortError } from './cachedFetch'
import { GlassTooltip } from './chartKit'
import { chartMargin, gridProps, lineProps, seriesColor, tooltipCursor, xAxisProps, yAxisProps } from './chartTheme'
import { fetchHistory, parseHistoryStates } from './history'
import type { HistoryPoint } from './history'
import './AdGuardCharts.css'

const HISTORY_TTL_MS = 10 * 60_000
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

const hourLabel = (value: number) => new Date(value).toLocaleTimeString([], { hour: 'numeric' })
const clockLabel = (value: string | number) => new Date(Number(value)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

interface AdGuardChartProps {
  title: string
  entityId: string | undefined
  unit: string
  /** Series colour index, so the four charts are told apart without implying they are related lines. */
  color: number
}

/** One 24-hour trend of one AdGuard sensor. Memoised: the page re-renders on every Home Assistant frame. */
const AdGuardChart = memo(function AdGuardChart({ title, entityId, unit, color }: AdGuardChartProps) {
  const [points, setPoints] = useState<HistoryPoint[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    if (!entityId) return
    const abort = new AbortController()
    fetchHistory(entityId, 24, HISTORY_TTL_MS, abort.signal)
      .then((payload) => { setPoints(parseHistoryStates(payload)); setState('ready') })
      .catch((failure: unknown) => { if (!isAbortError(failure)) setState('failed') })
    return () => abort.abort()
  }, [entityId])

  const stroke = seriesColor(color)
  const latest = points.length ? points[points.length - 1].value : null
  return (
    <section className="adguard-chart" aria-label={title}>
      <header>
        <h4>{title}</h4>
        {latest !== null && <strong>{number.format(latest)}{unit}</strong>}
      </header>
      {points.length > 1 ? (
        <div className="adguard-chart-body" data-swipe-ignore>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={chartMargin}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} tickFormatter={hourLabel} minTickGap={36} {...xAxisProps} />
              <YAxis domain={['auto', 'auto']} {...yAxisProps} />
              <Tooltip cursor={tooltipCursor} content={<GlassTooltip labelFormat={clockLabel} valueFormat={(value) => `${number.format(value)}${unit}`} />} />
              <Area type="monotone" dataKey="value" name={title} stroke={stroke} fill={stroke} fillOpacity={0.12} isAnimationActive={false} connectNulls {...lineProps} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="adguard-chart-note">
          {!entityId ? 'Not reported by AdGuard' : state === 'loading' ? 'Loading history…' : state === 'failed' ? 'Could not load history' : 'History starts once it has two readings'}
        </p>
      )}
    </section>
  )
})

interface AdGuardChartsProps {
  ids: { queries?: string; blocked?: string; ratio?: string; speed?: string }
}

/** Lookups, blocked, block rate and answer speed over the last day, two by two. */
export function AdGuardCharts({ ids }: AdGuardChartsProps) {
  return (
    <div className="adguard-charts">
      <AdGuardChart title="Lookups over time" entityId={ids.queries} unit="" color={0} />
      <AdGuardChart title="Blocked over time" entityId={ids.blocked} unit="" color={1} />
      <AdGuardChart title="Block rate" entityId={ids.ratio} unit="%" color={2} />
      <AdGuardChart title="Answer speed" entityId={ids.speed} unit=" ms" color={3} />
    </div>
  )
}
