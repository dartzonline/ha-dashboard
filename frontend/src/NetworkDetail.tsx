import { useEffect, useState } from 'react'
import { Activity, ArrowDownToLine, ArrowUpFromLine, MonitorSmartphone, ShieldCheck, WifiOff } from 'lucide-react'
import {
  Area, AreaChart, CartesianGrid, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { apiUrl } from './api'
import './NetworkDetail.css'

interface NetworkPoint {
  time: string
  downloadMbps: number | null
  uploadMbps: number | null
  devices: number
}

interface Summary {
  average: number | null
  min: number | null
  max: number | null
}

export interface OutageEvent {
  start: string
  end: string
  seconds: number
  ongoing: boolean
  blip: boolean
  sources: string[]
}

export interface Connectivity {
  uptimePercent: number
  downSeconds: number
  outageCount: number
  blipCount: number
  longestSeconds: number
  ongoing: boolean
  resolutionSeconds: number | null
  observedHours: number
  events: OutageEvent[]
  ipChanges: { at: string; from: string; to: string }[]
  wanState: string | null
  externalIp: string | null
}

export interface NetworkPayload {
  hours: number
  points: NetworkPoint[]
  download: Summary
  upload: Summary
  devices: Summary & { now: number; tracked: number }
  connectivity?: Connectivity
}

interface ChartRow {
  hour: number
  download: number | null
  upload: number | null
  devices: number
}

function formatHour(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric' })
}

export function mbps(value: number | null | undefined) {
  return value === null || value === undefined ? '--' : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} Mbps`
}

/** Compact duration: outages run from sub-second blips to hours. */
export function duration(seconds: number) {
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
}

function clockOf(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function dayOf(iso: string) {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/**
 * Uptime, outage count, and a timeline strip of when the internet dropped.
 *
 * Every figure here is qualified by how it was measured: the router is polled
 * (~30s), so a shorter drop can pass unrecorded, and Home Assistant's recorder
 * keeps far less history than the chart above may request. Stating the observed
 * window and resolution is what keeps "100% uptime" from overclaiming.
 */
export function ConnectivityPanel({ data }: { data: Connectivity }) {
  const windowStart = Date.now() - data.observedHours * 3600 * 1000
  const windowMs = Math.max(1, data.observedHours * 3600 * 1000)

  const marks = data.events.map((event) => {
    const start = Date.parse(event.start)
    const end = Date.parse(event.end)
    const left = Math.max(0, Math.min(100, ((start - windowStart) / windowMs) * 100))
    // Sub-second drops would round to zero width and vanish, so every mark
    // keeps a visible minimum.
    const width = Math.max(0.6, Math.min(100 - left, ((end - start) / windowMs) * 100))
    return { event, left, width }
  })

  const state = data.ongoing ? 'down' : data.outageCount > 0 || data.blipCount > 0 ? 'degraded' : 'ok'

  return (
    <div className={`network-uptime tone-${state}`}>
      <div className="network-uptime-head">
        <span>
          {state === 'down' ? <WifiOff size={13} /> : <ShieldCheck size={13} />}
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

      <div className="network-uptime-track" role="img" aria-label={
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
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const abort = new AbortController()
    fetch(apiUrl('insights/network?hours=24'), { signal: abort.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('unavailable'))))
      .then((data: NetworkPayload) => setPayload(data))
      .catch((error: unknown) => {
        if ((error as { name?: string }).name === 'AbortError') return
        setFailed(true)
      })
    return () => abort.abort()
  }, [])

  const rows: ChartRow[] = (payload?.points ?? []).map((point) => ({
    hour: Date.parse(point.time),
    download: point.downloadMbps,
    upload: point.uploadMbps,
    devices: point.devices,
  }))

  return (
    <section className="network-detail" aria-label="24 hour internet history">
      <header>
        <div><Activity size={17} /><h3>Last 24 hours</h3></div>
        <span>{payload ? `${payload.points.length} hourly averages` : failed ? 'History unavailable' : 'Loading…'}</span>
      </header>

      <div className="network-summary">
        <div className="tone-down">
          <span><ArrowDownToLine size={14} /> Download avg</span>
          <strong>{mbps(payload?.download.average)}</strong>
          <small>Peak {mbps(payload?.download.max)}</small>
        </div>
        <div className="tone-up">
          <span><ArrowUpFromLine size={14} /> Upload avg</span>
          <strong>{mbps(payload?.upload.average)}</strong>
          <small>Peak {mbps(payload?.upload.max)}</small>
        </div>
        <div className="tone-devices">
          <span><MonitorSmartphone size={14} /> Devices avg</span>
          <strong>{payload?.devices.average === null || payload === null ? '--' : Math.round(payload.devices.average)}</strong>
          <small>{payload ? `${payload.devices.now} now · ${payload.devices.tracked} tracked` : 'Counting clients'}</small>
        </div>
      </div>

      {payload?.connectivity && <ConnectivityPanel data={payload.connectivity} />}

      <div className="network-chart">
        {rows.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rows} margin={{ top: 8, right: 4, left: -24, bottom: 0 }}>
              <defs>
                <linearGradient id="networkDownFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--chart-line)" stopOpacity={.4} />
                  <stop offset="95%" stopColor="var(--chart-line)" stopOpacity={.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
              <XAxis dataKey="hour" tickFormatter={formatHour} tick={{ fontSize: 11, fill: 'var(--muted)' }} minTickGap={40} axisLine={false} tickLine={false} />
              <YAxis yAxisId="speed" tick={{ fontSize: 11, fill: 'var(--muted)' }} width={46} axisLine={false} tickLine={false} />
              {/* Devices ride a second axis: a 45-client count would otherwise flatten a 5 Mbps curve. */}
              <YAxis yAxisId="devices" orientation="right" tick={{ fontSize: 11, fill: 'var(--muted)' }} width={34} axisLine={false} tickLine={false} domain={['dataMin - 2', 'dataMax + 2']} />
              <Tooltip
                labelFormatter={(label) => formatHour(Number(label))}
                formatter={(value, name) => (name === 'Devices' ? [String(value), name] : [mbps(Number(value)), name])}
                contentStyle={{ borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 2 }} iconSize={9} />
              <Area yAxisId="speed" type="monotone" dataKey="download" name="Download" stroke="var(--chart-line)" strokeWidth={2} fill="url(#networkDownFill)" dot={false} connectNulls />
              <Area yAxisId="speed" type="monotone" dataKey="upload" name="Upload" stroke="var(--warn)" strokeWidth={2} fill="none" dot={false} connectNulls />
              <Line yAxisId="devices" type="monotone" dataKey="devices" name="Devices" stroke="var(--good)" strokeWidth={2} strokeDasharray="4 4" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="network-chart-empty">{failed ? 'Could not load network history' : 'Loading network history…'}</div>
        )}
      </div>
    </section>
  )
}
