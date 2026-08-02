import { useEffect, useState } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { BatteryCharging, Car, Gauge, Lock, LockOpen, MapPinned, ShieldCheck } from 'lucide-react'
import { apiUrl } from './api'
import type { HAEntity } from './types'
import { useVolvo } from './useVolvo'
import type { VolvoMetric } from './useVolvo'
import './VolvoView.css'

interface VolvoViewProps {
  entities: Map<string, HAEntity>
}

interface HistoryPoint {
  time: number
  value: number
}

function parseHistory(payload: unknown): HistoryPoint[] {
  if (!Array.isArray(payload)) return []
  const states = Array.isArray(payload[0]) ? payload[0] : payload
  return states.flatMap((item): HistoryPoint[] => {
    if (!item || typeof item !== 'object') return []
    const state = item as Record<string, unknown>
    const value = Number(state.state)
    const time = Date.parse(String(state.last_changed ?? state.last_updated ?? ''))
    return Number.isFinite(value) && Number.isFinite(time) ? [{ time, value }] : []
  })
}

/** 24-hour history for one metric, fetched fresh per car page visit rather than through the tile sparkline cache — this page wants a full chart, not a thumbnail. */
function useHistory(entityId: string | null) {
  const [points, setPoints] = useState<HistoryPoint[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!entityId) return
    const abort = new AbortController()
    let stopped = false
    queueMicrotask(() => { if (!stopped) setLoading(true) })
    fetch(apiUrl(`history/${entityId}?hours=24`), { signal: abort.signal })
      .then((response) => (response.ok ? response.json() : []))
      .then((payload) => { if (!stopped) setPoints(parseHistory(payload)) })
      .catch(() => {})
      .finally(() => { if (!stopped) setLoading(false) })
    return () => { stopped = true; abort.abort() }
  }, [entityId])

  return { points, loading }
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric' })
}

const tooltipStyle = { borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12 }

function TrendChart({ title, metric, color, unit }: { title: string; metric: VolvoMetric | null; color: string; unit: string }) {
  const { points, loading } = useHistory(metric?.entityId ?? null)
  const gradientId = `volvoFill-${title.replace(/\s+/g, '')}`

  return (
    <section className="volvo-chart" aria-label={title}>
      <header><Gauge size={14} /><h4>{title}</h4><span>{metric ? `${points.length} readings · 24h` : 'No matching sensor'}</span></header>
      <div className="volvo-chart-body">
        {points.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={.4} />
                  <stop offset="95%" stopColor={color} stopOpacity={.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(100,145,165,.16)" vertical={false} />
              <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} tickFormatter={formatTime} tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} minTickGap={38} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} domain={['auto', 'auto']} width={40} />
              <Tooltip labelFormatter={(label) => formatTime(Number(label))} formatter={(value) => [`${value}${unit}`, title]} contentStyle={tooltipStyle} />
              <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill={`url(#${gradientId})`} dot={false} connectNulls />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="volvo-chart-empty">
            <Gauge size={20} />
            <span>{loading ? 'Loading history…' : 'Not enough history yet'}</span>
          </div>
        )}
      </div>
    </section>
  )
}

export function VolvoView({ entities }: VolvoViewProps) {
  const car = useVolvo(entities)

  if (!car) {
    return (
      <section className="volvo-view volvo-view-empty" aria-label="Volvo">
        <Car size={28} />
        <p>No Volvo entities found yet.</p>
        <span>Connect Home Assistant's Volvo integration and this page fills in automatically — no dashboard config needed.</span>
      </section>
    )
  }

  const otherMetrics = car.metrics.filter((metric) => ![car.batteryMetric, car.rangeMetric, car.odometerMetric].some((hero) => hero?.entityId === metric.entityId))
  const lastUpdated = car.updatedAt ? new Date(car.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '--'

  return (
    <section className="volvo-view" aria-label="Volvo">
      <header className="volvo-header">
        <div><Car size={17} /><h3>{car.deviceName}</h3></div>
        <span>Last update {lastUpdated} · {car.metrics.length + car.binaries.length} signal{car.metrics.length + car.binaries.length === 1 ? '' : 's'}</span>
      </header>

      <div className="volvo-hero-row">
        <div className="volvo-hero-card tone-battery">
          <BatteryCharging size={20} />
          <div><span>Battery</span><strong>{car.batteryMetric?.value ?? '--'}</strong></div>
        </div>
        <div className="volvo-hero-card tone-range">
          <MapPinned size={20} />
          <div><span>Range</span><strong>{car.rangeMetric?.value ?? '--'}</strong></div>
        </div>
        <div className="volvo-hero-card tone-odometer">
          <Gauge size={20} />
          <div><span>Odometer</span><strong>{car.odometerMetric?.value ?? '--'}</strong></div>
        </div>
        <div className={`volvo-hero-card tone-lock ${car.locked?.on ? 'is-locked' : 'is-unlocked'}`}>
          {car.locked?.on ? <Lock size={20} /> : <LockOpen size={20} />}
          <div><span>Locks</span><strong>{car.locked ? (car.locked.on ? 'Locked' : 'Unlocked') : '--'}</strong></div>
        </div>
      </div>

      {otherMetrics.length > 0 && (
        <div className="volvo-metric-grid">
          {otherMetrics.map((metric) => (
            <div key={metric.entityId} className="volvo-metric-card">
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
            </div>
          ))}
        </div>
      )}

      {car.binaries.length > 0 && (
        <div className="volvo-status-row" aria-label="Doors, windows, and other status sensors">
          {car.binaries.map((item) => (
            <span key={item.entityId} className={`volvo-status-chip ${item.on ? 'is-on' : ''}`}>
              <ShieldCheck size={13} />{item.label}
              <em>{item.domain === 'lock' ? (item.on ? 'Locked' : 'Unlocked') : (item.on ? 'On' : 'Off')}</em>
            </span>
          ))}
        </div>
      )}

      <div className="volvo-chart-row">
        <TrendChart key={car.batteryMetric?.entityId ?? 'battery'} title="Battery" metric={car.batteryMetric} color="#39df8b" unit={car.batteryMetric?.unit ?? ''} />
        <TrendChart key={car.rangeMetric?.entityId ?? 'range'} title="Range" metric={car.rangeMetric} color="#55a8ff" unit={car.rangeMetric?.unit ?? ''} />
      </div>
    </section>
  )
}
