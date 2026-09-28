import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  Activity, ArrowDownToLine, ArrowUpFromLine, Globe, MonitorSmartphone, RotateCw, Router, Search, Wifi, WifiOff,
} from 'lucide-react'
import { cachedJson, isAbortError } from './cachedFetch'
import { ConnectivityPanel, ThroughputPanel } from './NetworkDetail'
import {
  DEVICES_COLOR, DOWNLOAD_COLOR, NETWORK_CACHE_TTL_MS, UPLOAD_COLOR, clientsPath, duration, mbps, networkPath, toChartRows,
} from './networkData'
import type { Connectivity, NetworkPayload } from './networkData'
import { tabListKeyHandler } from './tablist'
import type { HAEntity, TileConfig } from './types'
import { PageFrame } from './ui/PageFrame'
import { EmptyState, InlineError, LoadingState } from './ui/StateMessages'
import { useTwoTapConfirm } from './ui/useTwoTapConfirm'
import './NetworkView.css'

/** How long the router takes to come back, roughly, so the armed button can explain itself. */
const RESTART_WARNING = 'Every device loses its connection for a minute or two. Tap again to restart.'

interface NetworkViewProps {
  entities: Map<string, HAEntity>
  onService: (domain: string, service: string, data: Record<string, unknown>) => Promise<unknown>
  /** Opens the shared entity detail sheet, same as tiles in every other section. */
  onExpand: (tile: TileConfig) => void
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

interface CardContext {
  payload: NetworkPayload | null
  connectivity: Connectivity | undefined
  clients: ClientsPayload | null
}

/**
 * The summary cards, each backed by the Home Assistant entity it summarises so
 * tapping one opens that entity's detail sheet and history chart. Declared as
 * data rather than repeated markup because all four differ only in their glyph,
 * label and which figure they pull out.
 */
const CARDS: {
  entityId: string
  label: string
  icon: string
  /** The chart series this card summarises, so its key matches the line below. */
  color?: string
  glyph: ReactNode
  mono?: boolean
  render: (context: CardContext) => { value: string; detail: string }
}[] = [
  {
    entityId: 'sensor.cbr750_gateway_download_speed',
    label: 'Download',
    icon: 'gauge',
    color: DOWNLOAD_COLOR,
    glyph: <ArrowDownToLine size={14} />,
    render: ({ payload }) => ({
      value: mbps(payload?.download.average),
      detail: `Peak ${mbps(payload?.download.max)}`,
    }),
  },
  {
    entityId: 'sensor.cbr750_gateway_upload_speed',
    label: 'Upload',
    icon: 'gauge',
    color: UPLOAD_COLOR,
    glyph: <ArrowUpFromLine size={14} />,
    render: ({ payload }) => ({
      value: mbps(payload?.upload.average),
      detail: `Peak ${mbps(payload?.upload.max)}`,
    }),
  },
  {
    // No "clients online" entity exists, so this card fronts the WAN sensor --
    // the one entity whose detail sheet shows the whole network history view.
    entityId: 'binary_sensor.cbr750_gateway_wan_status',
    label: 'Devices',
    icon: 'wifi',
    color: DEVICES_COLOR,
    glyph: <MonitorSmartphone size={14} />,
    render: ({ payload, clients }) => ({
      value: payload ? String(payload.devices.now) : '--',
      detail: clients ? `${clients.trackedCount} known` : payload ? `${payload.devices.tracked} tracked` : 'Counting clients',
    }),
  },
  {
    entityId: 'sensor.cbr750_gateway_external_ip',
    label: 'External IP',
    icon: 'globe',
    glyph: <Globe size={14} />,
    mono: true,
    render: ({ connectivity }) => ({
      value: connectivity?.externalIp ?? '--',
      detail: connectivity && connectivity.ipChanges.length > 0
        ? `${connectivity.ipChanges.length} change${connectivity.ipChanges.length === 1 ? '' : 's'} in window`
        : 'Stable in window',
    }),
  },
]

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

/** Window options; the recorder rarely holds more than a day or two, and the
 *  panel reports how much it actually observed rather than assuming. */
const RANGES = [
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 },
]

export function NetworkView({ entities, onService, onExpand }: NetworkViewProps) {
  const [hours, setHours] = useState(24)
  const [payload, setPayload] = useState<NetworkPayload | null>(null)
  const [payloadAt, setPayloadAt] = useState(0)
  const [clients, setClients] = useState<ClientsPayload | null>(null)
  const [failed, setFailed] = useState(false)
  const [clientsError, setClientsError] = useState<string | null>(null)
  // Bumped by Retry. Failures are never cached, so re-running the effects is a real refetch.
  const [historyReload, setHistoryReload] = useState(0)
  const [clientsReload, setClientsReload] = useState(0)
  const [restarting, setRestarting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const restartConfirm = useTwoTapConfirm()

  // State is only set from the async callbacks: the page keeps showing the previous window's data
  // while the next one loads, instead of flashing empty on every range tap.
  useEffect(() => {
    const abort = new AbortController()
    cachedJson<NetworkPayload>(networkPath(hours), networkPath(hours), NETWORK_CACHE_TTL_MS, { signal: abort.signal })
      .then((data) => {
        setPayload(data)
        setPayloadAt(Date.now())
        setFailed(false)
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return
        setFailed(true)
      })
    return () => abort.abort()
  }, [hours, historyReload])

  // Separate request: the client list needs every device_tracker's history,
  // which is a much larger fetch than the speed summary above.
  useEffect(() => {
    const abort = new AbortController()
    cachedJson<ClientsPayload>(clientsPath(hours), clientsPath(hours), NETWORK_CACHE_TTL_MS, { signal: abort.signal })
      .then((data) => {
        setClients(data)
        setClientsError(null)
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return
        // Named, so the list stops claiming to be loading something that already failed.
        setClientsError(error instanceof Error ? error.message : 'Device list unavailable')
      })
    return () => abort.abort()
  }, [hours, clientsReload])

  function retryHistory() {
    setFailed(false)
    setHistoryReload((count) => count + 1)
  }

  function retryClients() {
    setClientsError(null)
    setClientsReload((count) => count + 1)
  }

  const connectivity = payload?.connectivity
  const wan = entities.get('binary_sensor.cbr750_gateway_wan_status')
  // Null until either source has spoken, so the page does not announce "offline" while it loads.
  const online: boolean | null = wan ? wan.state === 'on' : connectivity ? connectivity.wanState === 'on' : null
  const restartEntity = entities.get('button.cbr750_restart')

  async function restartRouter() {
    // First tap arms the button (and says what will happen); only the second sends the command.
    if (!restartConfirm.request()) {
      setNotice(null)
      return
    }
    setRestarting(true)
    setNotice(null)
    try {
      await onService('button', 'press', { entity_id: 'button.cbr750_restart' })
      setNotice('Restart sent — the router will be unreachable for a minute or two.')
    } catch (error) {
      // The backend's own reason (a rejected service call, HA offline) is more useful than a generic line.
      setNotice(error instanceof Error && error.message ? `Could not send the restart command — ${error.message}` : 'Could not send the restart command.')
    } finally {
      setRestarting(false)
    }
  }

  const rows = useMemo(() => toChartRows(payload), [payload])
  const needle = filter.trim().toLowerCase()
  const visibleClients = (clients?.clients ?? [])
    .filter((device) => !needle || [device.name, device.ip, device.mac, device.hostname]
      .some((field) => String(field ?? '').toLowerCase().includes(needle)))
    .sort((left, right) => ipOrder(left.ip) - ipOrder(right.ip))

  const deviceCount = clients?.onlineCount ?? payload?.devices.now
  const meta = [
    deviceCount !== undefined ? `${deviceCount} device${deviceCount === 1 ? '' : 's'} online` : null,
    payloadAt ? `Updated ${new Date(payloadAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : null,
  ].filter(Boolean).join(' · ')

  const rangeTabs = (
    <div
      className="network-range glass-pill"
      role="tablist"
      aria-label="History window"
      onKeyDown={tabListKeyHandler(RANGES.map((range) => range.hours), hours, setHours)}
    >
      {RANGES.map((range) => {
        const selected = hours === range.hours
        return (
          <button
            key={range.hours}
            type="button"
            role="tab"
            id={`network-range-${range.hours}`}
            aria-selected={selected}
            aria-controls="network-history-panel"
            tabIndex={selected ? 0 : -1}
            className={selected ? 'is-active' : ''}
            onClick={() => setHours(range.hours)}
          >
            {range.label}
          </button>
        )
      })}
    </div>
  )

  const actions = (
    <>
      {rangeTabs}
      {restartEntity && (
        <button
          type="button"
          className={`network-restart glass-pill ${restartConfirm.armed ? 'is-armed' : ''}`.trim()}
          onClick={() => void restartRouter()}
          onBlur={restartConfirm.disarm}
          disabled={restarting}
          aria-describedby={restartConfirm.armed ? 'network-restart-warning' : undefined}
        >
          <RotateCw size={16} aria-hidden="true" />
          {restarting ? 'Sending…' : restartConfirm.armed ? 'Tap again to restart' : 'Restart router'}
        </button>
      )}
    </>
  )

  const cardEntitiesMissing = CARDS.every((card) => !entities.has(card.entityId))
  if (cardEntitiesMissing && !payload && failed) {
    return (
      <PageFrame className="network-view" icon={<WifiOff />} title="No network data" actions={actions}>
        <EmptyState
          icon={<Router />}
          title="Nothing to show yet"
          hint="Looks for binary_sensor.cbr750_gateway_wan_status and the gateway speed sensors from the Netgear integration."
          action={<button type="button" className="glass-pill network-retry" onClick={retryHistory}><RotateCw size={16} aria-hidden="true" />Retry</button>}
        />
      </PageFrame>
    )
  }

  return (
    <PageFrame
      className="network-view"
      icon={online === false ? <WifiOff /> : <Wifi />}
      title={online === null ? 'Checking internet' : online ? 'Internet online' : 'Internet offline'}
      tone={online === null ? 'neutral' : online ? 'good' : 'danger'}
      meta={meta || undefined}
      actions={actions}
    >
      {restartConfirm.armed && !restarting && (
        <p className="network-notice is-warning" id="network-restart-warning" role="status">{RESTART_WARNING}</p>
      )}
      {notice && <p className="network-notice" role="status">{notice}</p>}

      {/* Each card fronts a real Home Assistant entity, so tapping one opens the
          same detail sheet (with its own history chart) that tiles elsewhere in
          the dashboard do -- rather than being a dead read-only figure. */}
      <div className="network-view-cards">
        {CARDS.map((card) => {
          const entity = entities.get(card.entityId)
          const body = card.render({ payload, connectivity, clients })
          return (
            <button
              key={card.entityId}
              type="button"
              className="glass glass-card network-card"
              onClick={entity ? () => onExpand({ entityId: card.entityId, label: card.label, kind: 'sensor', icon: card.icon }) : undefined}
              disabled={!entity}
              title={entity ? `Open ${card.label} history` : `${card.label} is unavailable`}
            >
              <span>
                {card.color && <i className="chart-key is-line" style={{ '--swatch': card.color } as CSSProperties} aria-hidden="true" />}
                {card.glyph} {card.label}
              </span>
              <strong className={card.mono ? 'network-ip' : undefined}>{body.value}</strong>
              <small>{body.detail}</small>
            </button>
          )
        })}
      </div>

      {connectivity && <ConnectivityPanel data={connectivity} windowEnd={payloadAt} className="glass glass-card" />}

      {connectivity && connectivity.events.length > 4 && (
        <div className="network-outage-log glass glass-card">
          <h3 className="network-card-title">All interruptions</h3>
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
        <div className="network-clients glass glass-card">
          <div className="network-panel-head">
            <h3 className="network-card-title"><MonitorSmartphone size={15} aria-hidden="true" />Connected devices</h3>
            {clients && <span>{clients.onlineCount} of {clients.trackedCount}</span>}
          </div>
          {clients && clients.clients.length > 0 && (
            <label className="network-filter glass-inset">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter by name, IP or MAC"
                aria-label="Filter connected devices"
              />
            </label>
          )}
          {clients ? (
            clients.clients.length === 0 ? (
              <EmptyState size="compact" icon={<MonitorSmartphone />} title="No devices reported" hint="Looks for device_tracker entities from the Netgear integration." />
            ) : visibleClients.length === 0 ? (
              <EmptyState size="compact" icon={<Search />} title={`Nothing matches “${filter.trim()}”`} />
            ) : (
              <ul>
                {visibleClients.map((device) => (
                  <li key={device.entityId}>
                    {/* Each row is a real device_tracker, so it opens the same
                        detail sheet as any other entity in the dashboard. */}
                    <button
                      type="button"
                      onClick={() => onExpand({ entityId: device.entityId, label: device.name, kind: 'sensor', icon: 'wifi' })}
                      title={`${device.hostname ?? device.name}${device.mac ? ` · ${device.mac}` : ''}`}
                    >
                      <span>{device.name}</span>
                      <code>{device.ip ?? '—'}</code>
                      <small>{device.since ? relative(device.since) : ''}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : clientsError ? (
            <InlineError message={`Could not load devices — ${clientsError}`} onRetry={retryClients} />
          ) : (
            <LoadingState label="Loading devices" size="compact" />
          )}
        </div>

        <div className="network-activity glass glass-card">
          <div className="network-panel-head">
            <h3 className="network-card-title"><Activity size={15} aria-hidden="true" />Recent activity</h3>
            {clients && <span>{clients.events.length} change{clients.events.length === 1 ? '' : 's'}</span>}
          </div>
          {clients ? (
            clients.events.length === 0 ? (
              <EmptyState size="compact" icon={<Activity />} title="No joins or leaves in this window" />
            ) : (
              <ul>
                {clients.events.slice(0, 24).map((event, index) => (
                  <li key={`${event.at}-${event.name}-${index}`}>
                    <i className={event.joined ? 'is-join' : 'is-leave'} aria-hidden="true" />
                    <span>{event.name}</span>
                    <em>{event.joined ? 'joined' : 'left'}</em>
                    <small>{relative(event.at)}</small>
                  </li>
                ))}
              </ul>
            )
          ) : clientsError ? (
            <InlineError message="Activity unavailable" onRetry={retryClients} />
          ) : (
            <LoadingState label="Loading activity" size="compact" />
          )}
        </div>

        <div className="network-router glass glass-card">
          <div className="network-panel-head">
            <h3 className="network-card-title"><Router size={15} aria-hidden="true" />Router</h3>
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
            <dd>{online === null ? '—' : online ? 'Online' : 'Offline'}</dd>
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

      <div
        className="network-view-chart glass glass-card"
        id="network-history-panel"
        role="tabpanel"
        aria-labelledby={`network-range-${hours}`}
      >
        <div className="network-panel-head">
          <h3 className="network-card-title"><Activity size={15} aria-hidden="true" />Throughput</h3>
          {payload && <span>{payload.points.length} hourly averages</span>}
        </div>
        {rows.length > 1 ? (
          // The page re-renders on every WebSocket frame; the panel is memoised on its rows.
          <ThroughputPanel rows={rows} idPrefix="page" />
        ) : failed ? (
          <InlineError message="Could not load network history" onRetry={retryHistory} />
        ) : payload ? (
          <EmptyState size="compact" icon={<Activity />} title="Not enough history in this window" hint="The chart needs at least two hourly averages from the gateway speed sensors." />
        ) : (
          <LoadingState label="Loading network history" size="compact" />
        )}
      </div>
    </PageFrame>
  )
}
