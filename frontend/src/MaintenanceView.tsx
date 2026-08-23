import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Download, ExternalLink, Filter, Gauge, Warehouse, Waves, WashingMachine,
} from 'lucide-react'
import { apiUrl } from './api'
import type { TileConfig } from './types'
import './MaintenanceView.css'

type Severity = 'critical' | 'warning' | 'ok' | 'unknown'

interface Consumable {
  entityId: string
  name: string
  fraction: number | null
  percent: number | null
  remainingHours: number | null
  overdue: boolean
  derived: boolean
  severity: Severity
}

interface Salt {
  depthCm: number | null
  reportedPercent: number | null
  percent: number | null
  fromDepth: boolean
  sensorDisagrees: boolean
  severity: Severity
}

interface Garage {
  entityId: string
  state: string
  obstructed: boolean
  openingSeconds: number | null
  closingSeconds: number | null
  openLimit: string | null
  closeLimit: string | null
  firmware: string | null
  durationEntities: string[]
}

interface Appliance {
  device: string
  name: string
  cycles?: number
  thisMonthWh?: number
  lastMonthWh?: number
  changePercent: number | null
  status: string | null
}

interface SoftwareUpdate {
  entityId: string
  name: string
  installedVersion: string | null
  latestVersion: string | null
  releaseSummary: string | null
  releaseUrl: string | null
  canInstall: boolean
  inProgress: boolean
  progressPercent: number | null
}

interface MaintenancePayload {
  consumables: Consumable[]
  salt: Salt | null
  garage: Garage | null
  faults: { entityId: string; name: string }[]
  appliances: Appliance[]
  updates: SoftwareUpdate[]
  counts: { critical: number; warning: number; ok: number }
}

interface MaintenanceViewProps {
  onExpand: (tile: TileConfig) => void
  onService: (domain: string, service: string, data: Record<string, unknown>) => Promise<unknown>
}

function kwh(wh: number | undefined) {
  if (wh === undefined) return '—'
  return `${(wh / 1000).toFixed(1)} kWh`
}

/** Strips the device name so a list of one device's parts reads cleanly. */
function shortName(name: string) {
  return name
    .replace(/^Roborock Qrevo MaxV\s*/i, '')
    .replace(/^Dyson [\w-]+\s*/i, '')
    .replace(/\s*time left$/i, '')
    .replace(/\s*Life$/i, '')
}

export function MaintenanceView({ onExpand, onService }: MaintenanceViewProps) {
  const [payload, setPayload] = useState<MaintenancePayload | null>(null)
  const [failed, setFailed] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback((signal?: AbortSignal) => {
    fetch(apiUrl('insights/maintenance'), { signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('unavailable'))))
      .then((data: MaintenancePayload) => { setPayload(data); setFailed(false) })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name === 'AbortError') return
        setFailed(true)
      })
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    load(abort.signal)
    // Wear changes over weeks and is worth polling slowly; an update in progress needs to be seen
    // moving, so the interval is short enough to show that without hammering the backend at rest.
    const timer = window.setInterval(() => load(), payload?.updates.some((item) => item.inProgress) ? 10_000 : 300_000)
    return () => { abort.abort(); window.clearInterval(timer) }
  }, [load, payload?.updates])

  const counts = payload?.counts
  const clear = counts !== undefined && counts.critical === 0 && counts.warning === 0 && (payload?.updates.length ?? 0) === 0

  const open = (entityId: string, label: string, icon: string) =>
    onExpand({ entityId, label, kind: 'sensor', icon })

  async function install(item: SoftwareUpdate) {
    // Installing Home Assistant's own core/supervisor is briefly disruptive -- the add-on this
    // dashboard runs as can restart along with it -- so it gets the same explicit confirmation
    // pattern as any other action here that cannot simply be undone by tapping again.
    const disruptive = item.entityId.startsWith('update.home_assistant_')
    if (disruptive && !window.confirm(`Install ${item.name} ${item.latestVersion ?? ''}? This may briefly restart Home Assistant.`)) return

    setInstalling(item.entityId)
    setNotice(null)
    try {
      await onService('update', 'install', { entity_id: item.entityId })
      load()
    } catch {
      setNotice(`Could not start the ${item.name} update.`)
    } finally {
      setInstalling(null)
    }
  }

  return (
    <section className="maint-view" aria-label="Maintenance">
      <header>
        <div>
          {clear ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          <h2>{clear ? 'Nothing due' : 'Maintenance due'}</h2>
        </div>
        <span>
          {failed ? 'Maintenance data unavailable'
            : counts
              ? `${counts.critical} due now · ${counts.warning} soon · ${counts.ok} healthy`
                + (payload && payload.updates.length > 0 ? ` · ${payload.updates.length} update${payload.updates.length === 1 ? '' : 's'} available` : '')
            : 'Checking…'}
        </span>
      </header>

      {notice && <p className="maint-notice" role="status">{notice}</p>}

      {payload && payload.updates.length > 0 && (
        <ul className="maint-updates">
          {payload.updates.map((item) => (
            <li key={item.entityId}>
              <div className="maint-update-body">
                <Download size={14} />
                <div className="maint-update-copy">
                  <strong>{item.name}</strong>
                  <span>
                    {item.installedVersion ?? '?'} → {item.latestVersion ?? '?'}
                    {item.releaseUrl && (
                      <a href={item.releaseUrl} target="_blank" rel="noreferrer" title="Open release notes">
                        <ExternalLink size={11} />
                      </a>
                    )}
                  </span>
                  {item.releaseSummary && <small>{item.releaseSummary}</small>}
                </div>
              </div>
              {item.canInstall ? (
                <button
                  type="button"
                  className="maint-update-install"
                  onClick={() => void install(item)}
                  disabled={installing !== null || item.inProgress}
                  title={`Install ${item.name} ${item.latestVersion ?? ''}`}
                >
                  {item.inProgress
                    ? (item.progressPercent !== null ? `Installing… ${Math.round(item.progressPercent)}%` : 'Installing…')
                    : installing === item.entityId ? 'Starting…' : 'Install'}
                </button>
              ) : (
                <span className="maint-update-manual">Update manually</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {payload && payload.faults.length > 0 && (
        <ul className="maint-faults">
          {payload.faults.map((fault) => (
            <li key={fault.entityId}>
              <button type="button" onClick={() => open(fault.entityId, fault.name, 'wrench')}>
                <AlertTriangle size={14} />
                <span>{fault.name}</span>
                <em>Device is reporting a fault</em>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="maint-panel">
        <div className="maint-panel-head">
          <Filter size={15} />
          <h3>Consumables</h3>
          <span>{payload ? `${payload.consumables.length} tracked` : '…'}</span>
        </div>
        <ul className="maint-bars">
          {(payload?.consumables ?? []).map((item) => (
            <li key={item.entityId} className={`tone-${item.severity}`}>
              <button type="button" onClick={() => open(item.entityId, item.name, 'filter')}>
                <span className="maint-bar-label">{shortName(item.name)}</span>
                <span className="maint-bar-track" role="presentation">
                  <i style={{ width: `${Math.max(1, item.percent ?? 0)}%` }} />
                </span>
                <em>
                  {item.overdue ? 'Overdue'
                    : item.percent === null ? 'Not reported'
                    : `${Math.round(item.percent)}%`}
                </em>
                <small>
                  {item.remainingHours !== null && !item.overdue ? `${Math.round(item.remainingHours)}h left` : ''}
                </small>
              </button>
            </li>
          ))}
          {payload && payload.consumables.length === 0 && <li className="is-empty">No consumables reported</li>}
        </ul>
        {(payload?.consumables ?? []).some((item) => item.derived) && (
          <p className="maint-note">
            {/* Roborock reports hours left, not a percentage, so the bar is computed
                against the manufacturer's service interval rather than read off the
                device. Saying so keeps it from being mistaken for a device figure. */}
            Percentages for hour-based items are derived from the manufacturer’s service intervals —
            the vacuum reports hours remaining, not a percentage.
          </p>
        )}
      </div>

      <div className="maint-grid">
        {payload?.salt && (
          <div className={`maint-panel tone-${payload.salt.severity}`}>
            <div className="maint-panel-head">
              <Waves size={15} />
              <h3>Water softener salt</h3>
            </div>
            <div className="maint-figure">
              <strong>{payload.salt.percent === null ? '—' : `${Math.round(payload.salt.percent)}%`}</strong>
              <small>{payload.salt.depthCm !== null ? `${payload.salt.depthCm} cm to surface` : 'Depth unavailable'}</small>
            </div>
            <span className="maint-bar-track is-wide" role="presentation">
              <i style={{ width: `${Math.max(1, payload.salt.percent ?? 0)}%` }} />
            </span>
            {payload.salt.sensorDisagrees && (
              <p className="maint-warn">
                {/* The percentage sensor read 0% while depth barely moved, so trusting
                    it would demand a refill that isn't needed. */}
                The tank’s own percentage reads {Math.round(payload.salt.reportedPercent ?? 0)}%, which
                disagrees with the depth reading — this figure comes from depth. The percentage sensor
                looks miscalibrated.
              </p>
            )}
            <button
              type="button"
              className="maint-link"
              onClick={() => open('sensor.esphome_web_79cc76_salt_level', 'Salt depth', 'waves')}
            >
              Open depth history
            </button>
          </div>
        )}

        {payload?.garage && (
          <div className={`maint-panel ${payload.garage.obstructed ? 'tone-critical' : ''}`}>
            <div className="maint-panel-head">
              <Warehouse size={15} />
              <h3>Garage door</h3>
              <span>{payload.garage.state}</span>
            </div>
            <dl className="maint-rows">
              <dt>Opening travel</dt>
              <dd>{payload.garage.openingSeconds !== null ? `${payload.garage.openingSeconds}s` : '—'}</dd>
              <dt>Closing travel</dt>
              <dd>{payload.garage.closingSeconds !== null ? `${payload.garage.closingSeconds}s` : '—'}</dd>
              <dt>Obstruction</dt>
              <dd className={payload.garage.obstructed ? 'is-bad' : ''}>
                {payload.garage.obstructed ? 'Detected' : 'Clear'}
              </dd>
              <dt>Limit switches</dt>
              <dd>{payload.garage.openLimit === 'on' ? 'At open' : payload.garage.closeLimit === 'on' ? 'At closed' : 'Mid travel'}</dd>
            </dl>
            <p className="maint-note">
              {/* Nothing in Home Assistant watches this number for change, but a door
                  that slowly takes longer to travel has a spring or roller going. */}
              Travel time is the wear signal — if these seconds creep up over months, the springs or
              rollers are on their way out.
            </p>
            <button
              type="button"
              className="maint-link"
              onClick={() => open(payload.garage!.durationEntities[0], 'Opening duration', 'gauge')}
            >
              Open travel-time history
            </button>
          </div>
        )}

        {(payload?.appliances ?? []).map((appliance) => (
          <div className="maint-panel" key={appliance.device}>
            <div className="maint-panel-head">
              {appliance.device === 'washer' ? <WashingMachine size={15} /> : <Gauge size={15} />}
              <h3>{appliance.name}</h3>
              {appliance.status && <span>{appliance.status.replaceAll('_', ' ')}</span>}
            </div>
            <dl className="maint-rows">
              {appliance.cycles !== undefined && (<><dt>Cycles</dt><dd>{appliance.cycles}</dd></>)}
              <dt>This month</dt>
              <dd>{kwh(appliance.thisMonthWh)}</dd>
              <dt>Last month</dt>
              <dd>{kwh(appliance.lastMonthWh)}</dd>
              {appliance.changePercent !== null && (
                <>
                  <dt>Change</dt>
                  {/* Rising consumption on an appliance used no more often is the
                      interesting case -- a fridge working harder usually means a
                      failing seal, so a rise is tinted and a fall is not. */}
                  <dd className={appliance.changePercent > 25 ? 'is-bad' : ''}>
                    {appliance.changePercent > 0 ? '+' : ''}{appliance.changePercent}%
                  </dd>
                </>
              )}
            </dl>
          </div>
        ))}
      </div>
    </section>
  )
}
