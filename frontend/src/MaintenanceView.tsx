import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Download, ExternalLink, Filter, Gauge, Warehouse, Waves, WashingMachine, Wrench,
} from 'lucide-react'
import { cachedJson, invalidate, isAbortError } from './cachedFetch'
import type { TileConfig } from './types'
import { PageFrame } from './ui/PageFrame'
import type { Tone } from './ui/PageFrame'
import { EmptyState, InlineError, LoadingState } from './ui/StateMessages'
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

/** Severity maps onto the shared pane tints; `ok`/`unknown` stay plain glass. */
const SEVERITY_TONE: Record<Severity, Tone> = { critical: 'danger', warning: 'warn', ok: 'neutral', unknown: 'neutral' }

/**
 * The wear bars are status meters, so a due item's fill takes the status tint -- but only ever next
 * to a word saying so, never colour alone.
 */
function severityWord(severity: Severity, overdue: boolean) {
  if (overdue || severity === 'critical') return 'Due now'
  if (severity === 'warning') return 'Due soon'
  return null
}

function attentionTitle(count: number) {
  if (count === 0) return 'Nothing needs attention'
  return `${count} thing${count === 1 ? ' needs' : 's need'} attention`
}

const MAINTENANCE_PATH = 'insights/maintenance'
/** Wear changes over weeks and is worth polling slowly. */
const MAINTENANCE_TTL_MS = 300_000
/** An update in progress needs to be seen moving. */
const INSTALLING_POLL_MS = 10_000

/** How long a disruptive install stays armed waiting for its confirming second tap. */
const CONFIRM_WINDOW_MS = 4_000

export function MaintenanceView({ onExpand, onService }: MaintenanceViewProps) {
  const [payload, setPayload] = useState<MaintenancePayload | null>(null)
  const [failed, setFailed] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Which disruptive update is waiting for its second tap. Per-row rather than the shared
  // one-button hook, because core and supervisor updates can both be listed at once.
  const [armedId, setArmedId] = useState<string | null>(null)
  const armTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => { if (armTimer.current) window.clearTimeout(armTimer.current) }, [])
  // Bumped by Retry; re-running the effect forces a fresh read instead of the cached copy.
  const [retryKey, setRetryKey] = useState(0)

  // A boolean rather than the `updates` array: the array is new on every fetch, and depending on
  // it re-ran this effect after each response -- a fetch that triggered another fetch, forever.
  const inProgress = payload?.updates.some((item) => item.inProgress) ?? false

  useEffect(() => {
    const abort = new AbortController()
    function load(force: boolean) {
      cachedJson<MaintenancePayload>(MAINTENANCE_PATH, MAINTENANCE_PATH, MAINTENANCE_TTL_MS, { signal: abort.signal, force })
        .then((data) => { setPayload(data); setFailed(false) })
        .catch((error: unknown) => {
          if (isAbortError(error)) return
          setFailed(true)
        })
    }
    // The mount read accepts a cached copy (the page re-mounts every rotation); the polls force a
    // refresh, short enough while an install is running to show it moving, slow otherwise.
    load(retryKey > 0)
    const timer = window.setInterval(() => load(true), inProgress ? INSTALLING_POLL_MS : MAINTENANCE_TTL_MS)
    return () => { abort.abort(); window.clearInterval(timer) }
  }, [inProgress, retryKey])

  const retry = () => { setFailed(false); setRetryKey((key) => key + 1) }
  const counts = payload?.counts
  const updateCount = payload?.updates.length ?? 0
  const attention = counts ? counts.critical + counts.warning + updateCount : 0
  const tone: Tone = !counts ? 'neutral'
    : counts.critical > 0 ? 'danger'
    : counts.warning > 0 || updateCount > 0 ? 'warn'
    : 'good'
  const nothingTracked = payload !== null
    && payload.consumables.length === 0 && !payload.salt && !payload.garage
    && payload.appliances.length === 0 && payload.faults.length === 0 && payload.updates.length === 0

  const open = (entityId: string, label: string, icon: string) =>
    onExpand({ entityId, label, kind: 'sensor', icon })

  async function install(item: SoftwareUpdate) {
    // Installing Home Assistant's own core/supervisor is briefly disruptive -- the add-on this
    // dashboard runs as can restart along with it -- so it gets the same explicit confirmation
    // pattern as any other action here that cannot simply be undone by tapping again.
    // Two taps rather than window.confirm, which ignores the panel's type scale and is suppressed
    // outright in some kiosk WebViews.
    const disruptive = item.entityId.startsWith('update.home_assistant_')
    if (disruptive && armedId !== item.entityId) {
      setArmedId(item.entityId)
      if (armTimer.current) window.clearTimeout(armTimer.current)
      armTimer.current = window.setTimeout(() => setArmedId(null), CONFIRM_WINDOW_MS)
      return
    }
    if (armTimer.current) window.clearTimeout(armTimer.current)
    setArmedId(null)

    setInstalling(item.entityId)
    setNotice(null)
    try {
      await onService('update', 'install', { entity_id: item.entityId })
      // The install just changed what the endpoint would say; drop the cached copy and re-read.
      invalidate(MAINTENANCE_PATH)
      const data = await cachedJson<MaintenancePayload>(MAINTENANCE_PATH, MAINTENANCE_PATH, MAINTENANCE_TTL_MS, { force: true })
      setPayload(data)
    } catch (error) {
      setNotice(error instanceof Error && error.message
        ? `Could not start the ${item.name} update — ${error.message}`
        : `Could not start the ${item.name} update.`)
    } finally {
      setInstalling(null)
    }
  }

  return (
    <section className="maint-view" aria-label="Maintenance">
      <PageFrame
        icon={!payload ? <Wrench /> : attention === 0 ? <CheckCircle2 /> : <AlertTriangle />}
        title={payload ? attentionTitle(attention) : 'Maintenance'}
        tone={tone}
        meta={counts
          ? `${counts.critical} due now · ${counts.warning} soon · ${counts.ok} healthy`
            + (updateCount > 0 ? ` · ${updateCount} update${updateCount === 1 ? '' : 's'} available` : '')
          : undefined}
      />

      {failed && (
        <InlineError
          message={payload ? 'Could not refresh maintenance data; showing the last result.' : 'Maintenance data unavailable'}
          onRetry={retry}
        />
      )}

      {notice && <p className="maint-notice" role="status"><AlertTriangle size={15} aria-hidden="true" />{notice}</p>}

      {!payload && !failed && <LoadingState label="Checking maintenance" />}

      {nothingTracked && (
        <EmptyState
          icon={<Wrench />}
          title="Nothing to maintain yet"
          hint="Looks for consumable life sensors (filters, brushes), a water softener salt level, a garage door opener, appliance energy counters and update.* entities."
        />
      )}

      {payload && payload.updates.length > 0 && (
        <ul className="maint-list glass">
          {payload.updates.map((item) => (
            <li key={item.entityId} className="maint-update">
              <div className="maint-update-body">
                <Download size={16} aria-hidden="true" />
                <div className="maint-update-copy">
                  <strong>{item.name}</strong>
                  <span>
                    {item.installedVersion ?? '?'} → {item.latestVersion ?? '?'}
                    {item.releaseUrl && (
                      <a className="hit-area" href={item.releaseUrl} target="_blank" rel="noreferrer" title="Open release notes" aria-label={`Release notes for ${item.name}`}>
                        <ExternalLink size={13} aria-hidden="true" />
                      </a>
                    )}
                  </span>
                  {item.releaseSummary && <small>{item.releaseSummary}</small>}
                </div>
              </div>
              {item.canInstall ? (
                <button
                  type="button"
                  className={`maint-update-install ${armedId === item.entityId ? 'is-armed' : ''}`.trim()}
                  onClick={() => void install(item)}
                  disabled={installing !== null || item.inProgress}
                  title={`Install ${item.name} ${item.latestVersion ?? ''}`}
                  aria-describedby={armedId === item.entityId ? `confirm-${item.entityId}` : undefined}
                >
                  {item.inProgress
                    ? (item.progressPercent !== null ? `Installing… ${Math.round(item.progressPercent)}%` : 'Installing…')
                    : installing === item.entityId ? 'Starting…'
                    : armedId === item.entityId ? 'Tap again to install' : 'Install'}
                </button>
              ) : (
                <span className="maint-update-manual">Update manually</span>
              )}
              {armedId === item.entityId && (
                <small id={`confirm-${item.entityId}`} className="maint-update-warning" role="status">This may briefly restart Home Assistant.</small>
              )}
            </li>
          ))}
        </ul>
      )}

      {payload && payload.faults.length > 0 && (
        <ul className="maint-list glass tone-danger">
          {payload.faults.map((fault) => (
            <li key={fault.entityId} className="maint-fault">
              <button type="button" onClick={() => open(fault.entityId, fault.name, 'wrench')}>
                <AlertTriangle size={16} aria-hidden="true" />
                <span>{fault.name}</span>
                <em>Device is reporting a fault</em>
              </button>
            </li>
          ))}
        </ul>
      )}

      {payload && !nothingTracked && (
        <section className="maint-panel glass" aria-label="Consumables">
          <header className="maint-panel-head">
            <h3><Filter size={14} aria-hidden="true" />Consumables</h3>
            <span>{payload.consumables.length} tracked</span>
          </header>
          {payload.consumables.length > 0 ? (
            <ul className="maint-bars">
              {payload.consumables.map((item) => {
                const word = severityWord(item.severity, item.overdue)
                return (
                  <li key={item.entityId} className={`is-${item.severity}${item.overdue ? ' is-critical' : ''}`}>
                    <button type="button" onClick={() => open(item.entityId, item.name, 'filter')}>
                      <span className="maint-bar-label">{shortName(item.name)}</span>
                      <span className="maint-bar-track glass-inset" role="presentation">
                        <i style={{ width: `${Math.max(1, item.percent ?? 0)}%` }} />
                      </span>
                      <em>
                        {item.overdue ? 'Overdue'
                          : item.percent === null ? 'Not reported'
                          : `${Math.round(item.percent)}%`}
                      </em>
                      <small className={word && !item.overdue ? 'is-word' : undefined}>
                        {word && !item.overdue ? word
                          : item.remainingHours !== null && !item.overdue ? `${Math.round(item.remainingHours)}h left` : ''}
                      </small>
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <EmptyState size="compact" icon={<Filter />} title="No consumables reported" hint="Looks for filter, brush and sensor life entities on vacuums and purifiers." />
          )}
          {payload.consumables.some((item) => item.derived) && (
            <p className="maint-note">
              {/* Roborock reports hours left, not a percentage, so the bar is computed
                  against the manufacturer's service interval rather than read off the
                  device. Saying so keeps it from being mistaken for a device figure. */}
              Percentages for hour-based items are derived from the manufacturer’s service intervals —
              the vacuum reports hours remaining, not a percentage.
            </p>
          )}
        </section>
      )}

      {payload && (payload.salt || payload.garage || payload.appliances.length > 0) && (
        <div className="maint-grid">
          {payload.salt && (
            <section className={`maint-panel glass tone-${SEVERITY_TONE[payload.salt.severity]} is-${payload.salt.severity}`} aria-label="Water softener salt">
              <header className="maint-panel-head">
                <h3><Waves size={14} aria-hidden="true" />Water softener salt</h3>
                {severityWord(payload.salt.severity, false) && <span className="maint-status">{payload.salt.severity === 'critical' ? 'Refill now' : 'Refill soon'}</span>}
              </header>
              <div className="maint-figure">
                <strong>{payload.salt.percent === null ? '—' : `${Math.round(payload.salt.percent)}%`}</strong>
                <small>{payload.salt.depthCm !== null ? `${payload.salt.depthCm} cm to surface` : 'Depth unavailable'}</small>
              </div>
              <span className="maint-bar-track is-wide glass-inset" role="presentation">
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
                className="maint-link glass-pill"
                onClick={() => open('sensor.esphome_web_79cc76_salt_level', 'Salt depth', 'waves')}
              >
                Open depth history
              </button>
            </section>
          )}

          {payload.garage && (
            <section className={`maint-panel glass ${payload.garage.obstructed ? 'tone-danger' : ''}`.trim()} aria-label="Garage door">
              <header className="maint-panel-head">
                <h3><Warehouse size={14} aria-hidden="true" />Garage door</h3>
                <span>{payload.garage.state}</span>
              </header>
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
              {payload.garage.durationEntities.length > 0 && (
                <button
                  type="button"
                  className="maint-link glass-pill"
                  onClick={() => open(payload.garage!.durationEntities[0], 'Opening duration', 'gauge')}
                >
                  Open travel-time history
                </button>
              )}
            </section>
          )}

          {payload.appliances.map((appliance) => (
            <section className="maint-panel glass" key={appliance.device} aria-label={appliance.name}>
              <header className="maint-panel-head">
                <h3>{appliance.device === 'washer' ? <WashingMachine size={14} aria-hidden="true" /> : <Gauge size={14} aria-hidden="true" />}{appliance.name}</h3>
                {appliance.status && <span>{appliance.status.replaceAll('_', ' ')}</span>}
              </header>
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
            </section>
          ))}
        </div>
      )}
    </section>
  )
}
