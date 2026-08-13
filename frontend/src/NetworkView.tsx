import { useCallback, useEffect, useState } from 'react'
import {
  Activity, ArrowDownToLine, ArrowUpFromLine, Globe, MonitorSmartphone, RotateCw, Router, Wifi, WifiOff,
} from 'lucide-react'
import {
  Area, AreaChart, CartesianGrid, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { apiUrl } from './api'
import { ConnectivityPanel, duration, mbps } from './NetworkDetail'
import type { NetworkPayload } from './NetworkDetail'
import type { HAEntity } from './types'
import './NetworkView.css'

/** How long the router takes to come back, roughly, so the button can explain itself. */
const RESTART_WARNING = 'Restart the router? Every device loses its connection for a minute or two.'

interface NetworkViewProps {
  entities: Map<string, HAEntity>
  onService: (domain: string, service: string, data: Record<string, unknown>) => Promise<unknown>
}

interface Client {
  entityId: string
  name: string
  ip: string | null
  mac: string | null
  hostname: string | null
  home: boolean
  since: string | null
}

interface ClientsPayload {
  hours: number
  onlineCount: number
  trackedCount: number
  clients: Client[]
  events: { at: string; name: string; joined: boolean }[]
  router: {
    firmwareInstalled: string | null
    firmwareLatest: string | null
    updateAvailable: boolean
  }
}

/** Sorts IPs numerically so 192.168.1.9 precedes 192.168.1.10. */
function ipOrder(ip: string | null) {
  if (!ip) return Number.MAX_SAFE_INTEGER
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(Number.isNaN)) return Number.MAX_SAFE_INTEGER
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]
}

function relative(iso: string) {
  const diff = Date.now() - Date.parse(iso)
  const minutes = Math.round(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function formatHour(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric' })
}

/** Window options; the recorder rarely holds more than a day or two, and the
 *  panel reports how much it actually observed rather than assuming. */
const RANGES = [
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 },
]

export function NetworkView({ entities, onService }: NetworkViewProps) {
  const [hours, setHours] = useState(24)
  const [payload, setPayload] = useState<NetworkPayload | null>(null)
  const [clients, setClients] = useState<ClientsPayload | null>(null)
  const [failed, setFailed] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const load = useCallback((signal?: AbortSignal) => {
    setFailed(false)
    fetch(apiUrl(`insights/network?hours=${hours}`), { signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('unavailable'))))
      .then((data: NetworkPayload) => setPayload(data))
      .catch((error: unknown) => {
        if ((error as { name?: string }).name === 'AbortError') return
        setFailed(true)
      })
  }, [hours])

  useEffect(() => {
    const abort = new AbortController()
    load(abort.signal)
    return () => abort.abort()
  }, [load])

  // Separate request: the client list needs every device_tracker's history,
  // which is a much larger fetch than the speed summary above.
  useEffect(() => {
    const abort = new AbortController()
    fetch(apiUrl(`insights/clients?hours=${hours}`), { signal: abort.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('unavailable'))))
      .then((data: ClientsPayload) => setClients(data))
      .catch((error: unknown) => {
        if ((error as { name?: string }).name === 'AbortError') return
      })
    return () => abort.abort()
  }, [hours])

  const connectivity = payload?.connectivity
  const wan = entities.get('binary_sensor.cbr750_gateway_wan_status')
  const online = wan ? wan.state === 'on' : connectivity?.wanState === 'on'
  const restartEntity = entities.get('button.cbr750_restart')

  async function restartRouter() {
    if (!window.confirm(RESTART_WARNING)) return
    setRestarting(true)
    setNotice(null)
    try {
      await onService('button', 'press', { entity_id: 'button.cbr750_restart' })
      setNotice('Restart sent — the router will be unreachable for a minute or two.')
    } catch {
      setNotice('Could not send the restart command.')
    } finally {
      setRestarting(false)
    }
  }

  const rows = (payload?.points ?? []).map((point) => ({
    hour: Date.parse(point.time),
    download: point.downloadMbps,
    upload: point.uploadMbps,
    devices: point.devices,
  }))

  return (
    <section className="network-view" aria-label="Internet and network">
      <header>
        <div>
          {online ? <Wifi size={17} /> : <WifiOff size={17} />}
          <h2>{online ? 'Internet online' : 'Internet offline'}</h2>
        </div>
        <div className="network-view-actions">
          <div className="network-range" role="tablist" aria-label="History window">
            {RANGES.map((range) => (
              <button
                key={range.hours}
                role="tab"
                aria-selected={hours === range.hours}
                className={hours === range.hours ? 'is-active' : ''}
                onClick={() => setHours(range.hours)}
              >
                {range.label}
              </button>
            ))}
          </div>
          {restartEntity && (
            <button
              type="button"
              className="network-restart"
              onClick={() => void restartRouter()}
              disabled={restarting}
              title="Restart the Orbi router"
            >
              <RotateCw size={14} />
              {restarting ? 'Sending…' : 'Restart router'}
            </button>
          )}
        </div>
      </header>

      {notice && <p className="network-notice" role="status">{notice}</p>}

      <div className="network-view-cards">
        <div className="tone-down">
          <span><ArrowDownToLine size={14} /> Download</span>
          <strong>{mbps(payload?.download.average)}</strong>
          <small>Peak {mbps(payload?.download.max)}</small>
        </div>
        <div className="tone-up">
          <span><ArrowUpFromLine size={14} /> Upload</span>
          <strong>{mbps(payload?.upload.average)}</strong>
          <small>Peak {mbps(payload?.upload.max)}</small>
        </div>
        <div className="tone-devices">
          <span><MonitorSmartphone size={14} /> Devices</span>
          <strong>{payload ? payload.devices.now : '--'}</strong>
          <small>{payload ? `${payload.devices.tracked} tracked` : 'Counting clients'}</small>
        </div>
        <div className="tone-ip">
          <span><Globe size={14} /> External IP</span>
          <strong className="network-ip">{connectivity?.externalIp ?? '--'}</strong>
          <small>
            {connectivity && connectivity.ipChanges.length > 0
              ? `${connectivity.ipChanges.length} change${connectivity.ipChanges.length === 1 ? '' : 's'} in window`
              : 'Stable in window'}
          </small>
        </div>
      </div>

      {connectivity && <ConnectivityPanel data={connectivity} />}

      {connectivity && connectivity.events.length > 4 && (
        <div className="network-outage-log">
          <h3>All interruptions</h3>
          <ul>
            {connectivity.events.map((event) => (
              <li key={event.start}>
                <span>
                  {new Date(event.start).toLocaleString([], {
                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                  })}
                </span>
                <em>{duration(event.seconds)}{event.ongoing ? ' · ongoing' : ''}</em>
                <small>{event.blip ? 'blip' : 'outage'} · {event.sources.join(' + ')}</small>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="network-lower">
        <div className="network-clients">
          <div className="network-panel-head">
            <MonitorSmartphone size={15} />
            <h3>Connected devices</h3>
            <span>{clients ? `${clients.onlineCount} of ${clients.trackedCount}` : '…'}</span>
          </div>
          <input
            className="network-filter"
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by name, IP or MAC"
            aria-label="Filter connected devices"
          />
          <ul>
            {(clients?.clients ?? [])
              .filter((device) => {
                const needle = filter.trim().toLowerCase()
                if (!needle) return true
                return [device.name, device.ip, device.mac, device.hostname]
                  .some((field) => String(field ?? '').toLowerCase().includes(needle))
              })
              .sort((left, right) => ipOrder(left.ip) - ipOrder(right.ip))
              .map((device) => (
                <li key={device.entityId}>
                  <span title={device.hostname ?? undefined}>{device.name}</span>
                  <code>{device.ip ?? '—'}</code>
                  <small title={device.mac ?? undefined}>{device.since ? relative(device.since) : ''}</small>
                </li>
              ))}
            {clients && clients.clients.length === 0 && <li className="is-empty">No devices reported</li>}
            {!clients && <li className="is-empty">Loading devices…</li>}
          </ul>
        </div>

        <div className="network-activity">
          <div className="network-panel-head">
            <Activity size={15} />
            <h3>Recent activity</h3>
            <span>{clients ? `${clients.events.length} changes` : '…'}</span>
          </div>
          <ul>
            {(clients?.events ?? []).slice(0, 24).map((event, index) => (
              <li key={`${event.at}-${event.name}-${index}`}>
                <i className={event.joined ? 'is-join' : 'is-leave'} aria-hidden="true" />
                <span>{event.name}</span>
                <em>{event.joined ? 'joined' : 'left'}</em>
                <small>{relative(event.at)}</small>
              </li>
            ))}
            {clients && clients.events.length === 0 && (
              <li className="is-empty">No joins or leaves in this window</li>
            )}
            {!clients && <li className="is-empty">Loading activity…</li>}
          </ul>
        </div>

        <div className="network-router">
          <div className="network-panel-head">
            <Router size={15} />
            <h3>Router</h3>
          </div>
          <dl>
            <dt>Firmware</dt>
            <dd>
              {clients?.router.firmwareInstalled ?? '—'}
              {clients?.router.updateAvailable
                ? <b className="is-update"> update available</b>
                : clients?.router.firmwareInstalled ? <b> up to date</b> : null}
            </dd>
            <dt>External IP</dt>
            <dd className="network-ip">{connectivity?.externalIp ?? '—'}</dd>
            <dt>WAN</dt>
            <dd>{online ? 'Online' : 'Offline'}</dd>
            <dt>Devices</dt>
            <dd>{clients ? `${clients.onlineCount} online · ${clients.trackedCount} known` : '—'}</dd>
          </dl>
          {connectivity && connectivity.ipChanges.length > 0 && (
            <div className="network-ip-log">
              <span>IP changes</span>
              <ul>
                {connectivity.ipChanges.slice(0, 3).map((change) => (
                  <li key={change.at}>
                    <small>{relative(change.at)}</small>
                    <code>{change.to}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* The Netgear integration exposes only gateway-wide throughput, so
              per-device bandwidth cannot be shown without inventing it. */}
          <p className="network-router-note">
            Per-device bandwidth isn’t available — the router only reports gateway totals.
          </p>
        </div>
      </div>

      <div className="network-view-chart">
        <div className="network-view-chart-head">
          <Activity size={15} />
          <h3>Throughput and devices</h3>
          <span>{payload ? `${payload.points.length} hourly averages` : failed ? 'History unavailable' : 'Loading…'}</span>
        </div>
        {rows.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rows} margin={{ top: 8, right: 4, left: -22, bottom: 0 }}>
              <defs>
                <linearGradient id="networkViewDownFill" x1="0" y1="0" x2="0" y2="1">
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
              <Area yAxisId="speed" type="monotone" dataKey="download" name="Download" stroke="var(--chart-line)" strokeWidth={2} fill="url(#networkViewDownFill)" dot={false} connectNulls />
              <Area yAxisId="speed" type="monotone" dataKey="upload" name="Upload" stroke="var(--warn)" strokeWidth={2} fill="none" dot={false} connectNulls />
              <Line yAxisId="devices" type="monotone" dataKey="devices" name="Devices" stroke="var(--good)" strokeWidth={2} strokeDasharray="4 4" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="network-view-empty">{failed ? 'Could not load network history' : 'Loading network history…'}</div>
        )}
      </div>
    </section>
  )
}
