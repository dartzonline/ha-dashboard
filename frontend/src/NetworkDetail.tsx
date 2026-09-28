import { memo, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { Activity, ArrowDownToLine, ArrowUpFromLine, MonitorSmartphone, ShieldCheck, WifiOff } from 'lucide-react'
import {
  Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { cachedJson, isAbortError } from './cachedFetch'
import { ChartLegend, GlassTooltip } from './chartKit'
import { chartMargin, gridProps, lineProps, tooltipCursor, xAxisProps, yAxisProps } from './chartTheme'
import { DEVICES_COLOR, DOWNLOAD_COLOR, NETWORK_CACHE_TTL_MS, UPLOAD_COLOR, duration, formatHour, mbps, networkPath, toChartRows } from './networkData'
import type { ChartRow, Connectivity, NetworkPayload } from './networkData'
import { EmptyState, InlineError, LoadingState } from './ui/StateMessages'
import './NetworkDetail.css'

function clockOf(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function dayOf(iso: string) {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function hourWithDay(timestamp: number) {
  return new Date(timestamp).toLocaleString([], { weekday: 'short', hour: 'numeric' })
}

function weekday(timestamp: number) {
  return new Date(timestamp).toLocaleDateString([], { weekday: 'short' })
}

/** The newest non-null reading: the last hour can be a gap while the recorder catches up. */
function latest(rows: ChartRow[], key: 'download' | 'upload' | 'devices') {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const value = rows[index][key]
    if (value !== null && value !== undefined) return value
  }
  return null
}

const deviceCount = (value: number) => `${Math.round(value)}`

/**
 * Throughput over the window, then the online-device count underneath on its own axis.
 *
 * These used to share one chart with a second y-axis, which invited reading a crossing of the
 * device line and the download curve as meaningful when it was only an artefact of two scales.
 * Devices get their own short strip instead: same x range and a synced cursor, so "the evening
 * dip is when everyone left" still reads, without two unit systems on one plot.
 */
export const ThroughputPanel = memo(function ThroughputPanel({ rows, idPrefix }: { rows: ChartRow[]; idPrefix: string }) {
  const spanHours = rows.length > 1 ? (rows[rows.length - 1].hour - rows[0].hour) / 3_600_000 : 0
  // Past a day and a half, bare hours repeat and stop saying where in the week a point sits.
  const tickFormat = spanHours > 36 ? weekday : formatHour
  const nowDevices = latest(rows, 'devices')

  return (
    <div className="network-throughput">
      <ChartLegend
        items={[
          { label: 'Download', color: DOWNLOAD_COLOR, value: mbps(latest(rows, 'download')) },
          { label: 'Upload', color: UPLOAD_COLOR, value: mbps(latest(rows, 'upload')) },
        ]}
      />
      <div className="network-throughput-plot" data-swipe-ignore>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={chartMargin} syncId={`${idPrefix}-network`}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="hour" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={tickFormat} minTickGap={40} {...xAxisProps} />
            <YAxis {...yAxisProps} width={44} />
            <Tooltip cursor={tooltipCursor} content={<GlassTooltip valueFormat={(value) => mbps(value)} labelFormat={(label) => hourWithDay(Number(label))} />} />
            <Area type="monotone" dataKey="download" name="Download" stroke={DOWNLOAD_COLOR} fill={DOWNLOAD_COLOR} fillOpacity={0.1} connectNulls {...lineProps} />
            <Area type="monotone" dataKey="upload" name="Upload" stroke={UPLOAD_COLOR} fill={UPLOAD_COLOR} fillOpacity={0.1} connectNulls {...lineProps} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="network-devices-strip">
        <p className="network-devices-head">
          <span className="chart-key is-line" style={{ '--swatch': DEVICES_COLOR } as CSSProperties} aria-hidden="true" />
          <span>Devices online</span>
          {nowDevices !== null && <strong>{deviceCount(nowDevices)}</strong>}
        </p>
        <div className="network-devices-plot" data-swipe-ignore>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={chartMargin} syncId={`${idPrefix}-network`}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="hour" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={tickFormat} minTickGap={40} {...xAxisProps} />
              {/* Padded so a steady 40-client evening still shows its small swings instead of a flat line. */}
              <YAxis {...yAxisProps} width={44} allowDecimals={false} tickCount={3} domain={['dataMin - 2', 'dataMax + 2']} />
              <Tooltip cursor={tooltipCursor} content={<GlassTooltip valueFormat={deviceCount} labelFormat={(label) => hourWithDay(Number(label))} />} />
              <Line type="monotone" dataKey="devices" name="Devices" stroke={DEVICES_COLOR} {...lineProps} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
})

/**
 * Uptime, outage count, and a timeline strip of when the internet dropped.
 *
 * Every figure here is qualified by how it was measured: the router is polled
 * (~30s), so a shorter drop can pass unrecorded, and Home Assistant's recorder
 * keeps far less history than the chart above may request. Stating the observed
 * window and resolution is what keeps "100% uptime" from overclaiming.
 */
export function ConnectivityPanel({ data, windowEnd, className = '' }: {
  data: Connectivity
  /** When the payload was received: the observed window runs back from there, not from the current render. */
  windowEnd: number
  /** Lets the Network page make this a pane of its own; inside the detail sheet it stays a flat well. */
  className?: string
}) {
  const marks = useMemo(() => {
    const windowMs = Math.max(1, data.observedHours * 3600 * 1000)
    const windowStart = windowEnd - windowMs
    return data.events.map((event) => {
      const start = Date.parse(event.start)
      const end = Date.parse(event.end)
      const left = Math.max(0, Math.min(100, ((start - windowStart) / windowMs) * 100))
      // Sub-second drops would round to zero width and vanish, so every mark
      // keeps a visible minimum.
      const width = Math.max(0.6, Math.min(100 - left, ((end - start) / windowMs) * 100))
      return { event, left, width }
    })
  }, [data, windowEnd])

  const state = data.ongoing ? 'down' : data.outageCount > 0 || data.blipCount > 0 ? 'degraded' : 'ok'

  return (
    <div className={`network-uptime is-${state} ${className}`.trim()}>
      <div className="network-uptime-head">
        <span>
          {state === 'down' ? <WifiOff size={14} /> : <ShieldCheck size={14} />}
          Internet uptime
        </span>
        <small>
          {`over ${data.observedHours >= 1 ? `${Math.round(data.observedHours)}h` : `${Math.round(data.observedHours * 60)}m`} observed`}
          {data.resolutionSeconds ? ` · ~${Math.round(data.resolutionSeconds)}s resolution` : ''}
        </small>
      </div>

      <div className="network-uptime-figures">
        <div>
          <strong>{data.uptimePercent.toFixed(data.uptimePercent >= 99.9 ? 3 : 2)}%</strong>
          <small>{data.ongoing ? 'Currently down' : 'Uptime'}</small>
        </div>
        <div>
          <strong>{data.outageCount}</strong>
          <small>{data.outageCount === 1 ? 'Outage' : 'Outages'}</small>
        </div>
        {data.blipCount > 0 && (
          <div>
            <strong>{data.blipCount}</strong>
            <small>{data.blipCount === 1 ? 'Blip' : 'Blips'}</small>
          </div>
        )}
        <div>
          <strong>{data.downSeconds > 0 ? duration(data.downSeconds) : '—'}</strong>
          <small>Total down</small>
        </div>
      </div>

      <div className="network-uptime-track glass-inset" role="img" aria-label={
        data.events.length === 0
          ? 'No outages in the observed window'
          : `${data.events.length} connectivity interruptions`
      }>
        {marks.map(({ event, left, width }) => (
          <i
            key={event.start}
            className={event.blip ? 'is-blip' : event.ongoing ? 'is-ongoing' : ''}
            style={{ left: `${left}%`, width: `${width}%` }}
            title={`${dayOf(event.start)} ${clockOf(event.start)} · ${duration(event.seconds)} · ${event.sources.join(' + ')}`}
          />
        ))}
      </div>

      {data.events.length > 0 && (
        <ul className="network-uptime-list">
          {data.events.slice(0, 4).map((event) => (
            <li key={event.start}>
              <span>{dayOf(event.start)} {clockOf(event.start)}</span>
              <em>{duration(event.seconds)}{event.ongoing ? ' · ongoing' : ''}</em>
              <small>{event.sources.join(' + ')}</small>
            </li>
          ))}
        </ul>
      )}

      {data.events.length === 0 && (
        <p className="network-uptime-clean">
          No drops recorded{data.resolutionSeconds ? ` — anything under ~${Math.round(data.resolutionSeconds)}s would not be visible` : ''}
        </p>
      )}
    </div>
  )
}

export function NetworkDetail() {
  const [payload, setPayload] = useState<NetworkPayload | null>(null)
  const [receivedAt, setReceivedAt] = useState(0)
  const [failed, setFailed] = useState(false)
  // Bumped by Retry: failures are never cached, so re-running the effect is a real refetch.
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    // Shares its cache entry with the Network page's 24 h view, so opening this sheet right after
    // visiting that page costs nothing.
    cachedJson<NetworkPayload>(networkPath(24), networkPath(24), NETWORK_CACHE_TTL_MS, { signal: abort.signal })
      .then((data) => {
        setPayload(data)
        setReceivedAt(Date.now())
        setFailed(false)
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return
        setFailed(true)
      })
    return () => abort.abort()
  }, [reload])

  const rows = useMemo(() => toChartRows(payload), [payload])
  const retry = () => {
    setFailed(false)
    setReload((count) => count + 1)
  }

  return (
    <section className="network-detail" aria-label="24 hour internet history">
      <header className="network-detail-head">
        <h3><Activity size={16} aria-hidden="true" />Last 24 hours</h3>
        {payload && <span>{payload.points.length} hourly averages</span>}
      </header>

      <div className="network-summary">
        <div>
          <span><i className="chart-key is-line" style={{ '--swatch': DOWNLOAD_COLOR } as CSSProperties} aria-hidden="true" /><ArrowDownToLine size={14} aria-hidden="true" /> Download avg</span>
          <strong>{mbps(payload?.download.average)}</strong>
          <small>Peak {mbps(payload?.download.max)}</small>
        </div>
        <div>
          <span><i className="chart-key is-line" style={{ '--swatch': UPLOAD_COLOR } as CSSProperties} aria-hidden="true" /><ArrowUpFromLine size={14} aria-hidden="true" /> Upload avg</span>
          <strong>{mbps(payload?.upload.average)}</strong>
          <small>Peak {mbps(payload?.upload.max)}</small>
        </div>
        <div>
          <span><i className="chart-key is-line" style={{ '--swatch': DEVICES_COLOR } as CSSProperties} aria-hidden="true" /><MonitorSmartphone size={14} aria-hidden="true" /> Devices avg</span>
          <strong>{payload?.devices.average === null || payload === null ? '--' : Math.round(payload.devices.average)}</strong>
          <small>{payload ? `${payload.devices.now} now · ${payload.devices.tracked} tracked` : 'Counting clients'}</small>
        </div>
      </div>

      {payload?.connectivity && <ConnectivityPanel data={payload.connectivity} windowEnd={receivedAt} />}

      <div className="network-chart">
        {rows.length > 1 ? (
          <ThroughputPanel rows={rows} idPrefix="detail" />
        ) : failed ? (
          <InlineError message="Could not load network history" onRetry={retry} />
        ) : payload ? (
          <EmptyState size="compact" icon={<Activity />} title="Not enough history yet" hint="The chart needs at least two hourly averages from the gateway speed sensors." />
        ) : (
          <LoadingState label="Loading network history" size="compact" />
        )}
      </div>
    </section>
  )
}
