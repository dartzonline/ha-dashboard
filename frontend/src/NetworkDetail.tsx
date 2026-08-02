import { useEffect, useState } from 'react'
import { Activity, ArrowDownToLine, ArrowUpFromLine, MonitorSmartphone } from 'lucide-react'
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

interface NetworkPayload {
  hours: number
  points: NetworkPoint[]
  download: Summary
  upload: Summary
  devices: Summary & { now: number; tracked: number }
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

function mbps(value: number | null | undefined) {
  return value === null || value === undefined ? '--' : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} Mbps`
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
