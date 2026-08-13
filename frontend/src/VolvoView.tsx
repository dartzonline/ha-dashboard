import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  BatteryCharging, Car, CircleAlert, CircleCheck, CircleGauge, Disc3, DoorOpen, Droplets, Fuel, Gauge,
  Lightbulb, Lock, LockOpen, MapPinned, Moon, Plug, Route, ShieldAlert, ShieldCheck, Wrench,
} from 'lucide-react'
import { apiUrl } from './api'
import type { HAEntity, TileConfig, TileKind } from './types'
import { useVolvo } from './useVolvo'
import './VolvoView.css'

interface VolvoViewProps {
  entities: Map<string, HAEntity>
  /** Opens the shared entity detail sheet, same as tiles in every other section. */
  onExpand: (tile: TileConfig) => void
}

interface HistoryPoint {
  time: number
  value: number
}

/** Every entity ID below was read off the live Home Assistant dump; nothing here is guessed. */
const ID = {
  battery: 'sensor.volvo_xc60_battery',
  batteryCapacity: 'sensor.volvo_xc60_battery_capacity',
  targetCharge: 'sensor.volvo_xc60_target_battery_charge_level',
  chargingStatus: 'sensor.volvo_xc60_charging_status',
  chargingConnection: 'sensor.volvo_xc60_charging_connection_status',
  chargingPower: 'sensor.volvo_xc60_charging_power',
  chargingPowerStatus: 'sensor.volvo_xc60_charging_power_status',
  chargingType: 'sensor.volvo_xc60_charging_type',
  chargingTime: 'sensor.volvo_xc60_estimated_charging_time',
  rangeBattery: 'sensor.volvo_xc60_distance_to_empty_battery',
  rangeTank: 'sensor.volvo_xc60_distance_to_empty_tank',
  fuelAmount: 'sensor.volvo_xc60_fuel_amount',
  odometer: 'sensor.volvo_xc60_odometer',
  lock: 'lock.volvo_xc60_lock',
  connection: 'sensor.volvo_xc60_car_connection',
  engine: 'binary_sensor.volvo_xc60_engine_status',
  service: 'sensor.volvo_xc60_service',
  distanceToService: 'sensor.volvo_xc60_distance_to_service',
  timeToService: 'sensor.volvo_xc60_time_to_service',
  timeToEngineService: 'sensor.volvo_xc60_time_to_engine_service',
} as const

/** Grouped for the closures panel so a glance answers "is anything open?" without reading labels. */
const CLOSURES: { group: string; items: { entityId: string; label: string }[] }[] = [
  {
    group: 'Doors',
    items: [
      { entityId: 'binary_sensor.volvo_xc60_door_front_left', label: 'Front L' },
      { entityId: 'binary_sensor.volvo_xc60_door_front_right', label: 'Front R' },
      { entityId: 'binary_sensor.volvo_xc60_door_rear_left', label: 'Rear L' },
      { entityId: 'binary_sensor.volvo_xc60_door_rear_right', label: 'Rear R' },
    ],
  },
  {
    group: 'Windows',
    items: [
      { entityId: 'binary_sensor.volvo_xc60_window_front_left', label: 'Front L' },
      { entityId: 'binary_sensor.volvo_xc60_window_front_right', label: 'Front R' },
      { entityId: 'binary_sensor.volvo_xc60_window_rear_left', label: 'Rear L' },
      { entityId: 'binary_sensor.volvo_xc60_window_rear_right', label: 'Rear R' },
    ],
  },
  {
    group: 'Body',
    items: [
      { entityId: 'binary_sensor.volvo_xc60_hood', label: 'Hood' },
      { entityId: 'binary_sensor.volvo_xc60_tailgate', label: 'Tailgate' },
      { entityId: 'binary_sensor.volvo_xc60_tank_lid', label: 'Tank lid' },
      { entityId: 'binary_sensor.volvo_xc60_sunroof', label: 'Sunroof' },
    ],
  },
]

/**
 * The Volvo API exposes tyres as pressure *warnings*, not readings -- there is no
 * kPa/psi sensor to chart. Showing a fabricated number would be worse than showing none.
 */
const TYRES = [
  { entityId: 'binary_sensor.volvo_xc60_tire_front_left', label: 'Front left' },
  { entityId: 'binary_sensor.volvo_xc60_tire_front_right', label: 'Front right' },
  { entityId: 'binary_sensor.volvo_xc60_tire_rear_left', label: 'Rear left' },
  { entityId: 'binary_sensor.volvo_xc60_tire_rear_right', label: 'Rear right' },
]

const FLUIDS = [
  { entityId: 'binary_sensor.volvo_xc60_oil_level', label: 'Oil' },
  { entityId: 'binary_sensor.volvo_xc60_coolant_level', label: 'Coolant' },
  { entityId: 'binary_sensor.volvo_xc60_brake_fluid', label: 'Brake fluid' },
  { entityId: 'binary_sensor.volvo_xc60_washer_fluid', label: 'Washer' },
]

/** "Manual" is the odometer-style trip the driver resets; "automatic" is the current journey. */
const TRIPS = [
  {
    column: 'Current trip',
    distance: 'sensor.volvo_xc60_trip_automatic_distance',
    speed: 'sensor.volvo_xc60_trip_automatic_average_speed',
    fuel: 'sensor.volvo_xc60_trip_automatic_average_fuel_consumption',
    energy: null,
  },
  {
    column: 'Since reset',
    distance: 'sensor.volvo_xc60_trip_manual_distance',
    speed: 'sensor.volvo_xc60_trip_manual_average_speed',
    fuel: 'sensor.volvo_xc60_trip_manual_average_fuel_consumption',
    energy: 'sensor.volvo_xc60_trip_manual_average_energy_consumption',
  },
]

/** Bulb-outage sensors, matched against real entity keys rather than a hardcoded list of twenty. */
const BULB_PATTERN = /(light|beam|indication)/

const DEAD_STATES = new Set(['unavailable', 'unknown', 'none', ''])

/** Returns the entity only when it carries a real reading, so callers can never format `unavailable`. */
function live(entity: HAEntity | undefined) {
  return entity && !DEAD_STATES.has(entity.state) ? entity : undefined
}

function numberOf(entity: HAEntity | undefined) {
  const found = live(entity)
  if (!found) return null
  const value = Number(found.state)
  return Number.isFinite(value) ? value : null
}

function unitOf(entity: HAEntity | undefined) {
  return typeof entity?.attributes.unit_of_measurement === 'string' ? entity.attributes.unit_of_measurement : ''
}

/** `null` rather than a dash, so every caller decides its own placeholder wording. */
function measure(entity: HAEntity | undefined, digits = 0) {
  const value = numberOf(entity)
  if (value === null) return null
  const unit = unitOf(entity)
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value)}${unit ? ` ${unit}` : ''}`
}

function words(state: string) {
  return state.replaceAll('_', ' ').replace(/^./, (character) => character.toUpperCase())
}

function enumLabel(entity: HAEntity | undefined) {
  const found = live(entity)
  return found ? words(found.state) : null
}

type Openness = 'open' | 'closed' | 'unknown'

function openness(entity: HAEntity | undefined): Openness {
  const found = live(entity)
  if (!found) return 'unknown'
  return found.state === 'on' ? 'open' : 'closed'
}

type Health = 'ok' | 'problem' | 'unknown'

/** Volvo's `problem` sensors read `on` for a fault, and `unknown` while the car sleeps. */
function health(entity: HAEntity | undefined): Health {
  const found = live(entity)
  if (!found) return 'unknown'
  return found.state === 'on' ? 'problem' : 'ok'
}

function relativeAge(iso: string | null | undefined) {
  if (!iso) return null
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000)
  if (!Number.isFinite(minutes)) return null
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Minutes are what the car reports; hours read better once a charge is more than an hour out. */
function chargeEta(minutes: number | null) {
  if (minutes === null || minutes <= 0) return null
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
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

function TrendChart({ title, entityId, color, unit }: { title: string; entityId: string | null; color: string; unit: string }) {
  const { points, loading } = useHistory(entityId)
  const gradientId = `volvoFill-${title.replace(/\s+/g, '')}`

  return (
    <section className="volvo-chart" aria-label={title}>
      <header><Gauge size={14} /><h4>{title}</h4><span>{entityId ? `${points.length} readings · 24h` : 'No matching sensor'}</span></header>
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
              <Tooltip labelFormatter={(label) => formatTime(Number(label))} formatter={(value) => [`${value}${unit ? ` ${unit}` : ''}`, title]} contentStyle={tooltipStyle} />
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

export function VolvoView({ entities, onExpand }: VolvoViewProps) {
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

  const get = (entityId: string) => entities.get(entityId)
  const open = (entityId: string, label: string, icon: string, kind: TileKind = 'sensor') => {
    if (entities.has(entityId)) onExpand({ entityId, label, kind, icon })
  }

  const battery = get(ID.battery)
  const lock = get(ID.lock)
  const locked = live(lock) ? lock?.state === 'locked' : null
  const chargingStatus = get(ID.chargingStatus)
  const plugged = live(get(ID.chargingConnection))?.state === 'connected'
  const chargingNow = live(chargingStatus)?.state === 'charging'
  const chargePower = numberOf(get(ID.chargingPower))
  const eta = chargeEta(numberOf(get(ID.chargingTime)))
  const engineRunning = live(get(ID.engine))?.state === 'on'
  const connection = get(ID.connection)
  // `available` means the car is reachable now; anything else means the figures below are last-known.
  const reachable = live(connection)?.state === 'available'

  const closureItems = CLOSURES.flatMap((section) => section.items)
  const openClosures = closureItems.filter((item) => openness(get(item.entityId)) === 'open')
  const unreadClosures = closureItems.filter((item) => openness(get(item.entityId)) === 'unknown')
  const tyreFaults = TYRES.filter((tyre) => health(get(tyre.entityId)) === 'problem')
  const tyreUnread = TYRES.filter((tyre) => health(get(tyre.entityId)) === 'unknown')
  const fluidFaults = FLUIDS.filter((fluid) => health(get(fluid.entityId)) === 'problem')

  const bulbs = Array.from(entities.values()).filter((entity) => (
    entity.entity_id.startsWith('binary_sensor.volvo') && BULB_PATTERN.test(entity.entity_id)
  ))
  const bulbFaults = bulbs.filter((bulb) => health(bulb) === 'problem')

  const serviceState = live(get(ID.service))
  const serviceWarning = Boolean(serviceState && serviceState.state !== 'no_warning')

  const alerts = openClosures.length + tyreFaults.length + fluidFaults.length + bulbFaults.length
    + (locked === false ? 1 : 0) + (serviceWarning ? 1 : 0)

  const heroCards: {
    entityId: string
    label: string
    icon: string
    tone: string
    kind?: TileKind
    glyph: ReactNode
    value: string
    detail: string
  }[] = [
    {
      entityId: ID.battery,
      label: 'Battery',
      icon: 'battery',
      tone: 'tone-battery',
      glyph: <BatteryCharging size={15} />,
      value: measure(battery, 0) ?? '--',
      detail: [measure(get(ID.batteryCapacity), 1), measure(get(ID.targetCharge), 0) ? `target ${measure(get(ID.targetCharge), 0)}` : null]
        .filter(Boolean).join(' · ') || 'No reading',
    },
    {
      entityId: ID.rangeBattery,
      label: 'Electric range',
      icon: 'gauge',
      tone: 'tone-range',
      glyph: <MapPinned size={15} />,
      value: measure(get(ID.rangeBattery), 0) ?? '--',
      detail: measure(get(ID.rangeTank), 0) ? `${measure(get(ID.rangeTank), 0)} on fuel` : 'Fuel range unknown',
    },
    {
      entityId: ID.rangeTank,
      label: 'Fuel',
      icon: 'droplets',
      tone: 'tone-fuel',
      glyph: <Fuel size={15} />,
      value: measure(get(ID.fuelAmount), 1) ?? '--',
      detail: measure(get(ID.rangeTank), 0) ? `${measure(get(ID.rangeTank), 0)} range` : 'No reading',
    },
    {
      entityId: ID.chargingStatus,
      label: 'Charging',
      icon: 'battery',
      tone: chargingNow ? 'tone-charging is-charging' : 'tone-charging',
      glyph: <Plug size={15} />,
      value: enumLabel(chargingStatus) ?? '--',
      detail: [
        plugged ? 'Plugged in' : live(get(ID.chargingConnection)) ? 'Unplugged' : null,
        chargePower !== null && chargePower > 0 ? measure(get(ID.chargingPower), 0) : null,
        eta ? `${eta} left` : null,
        enumLabel(get(ID.chargingType)) && plugged ? `${live(get(ID.chargingType))?.state.toUpperCase()}` : null,
      ].filter(Boolean).join(' · ') || 'Not charging',
    },
    {
      entityId: ID.odometer,
      label: 'Odometer',
      icon: 'gauge',
      tone: 'tone-odometer',
      glyph: <CircleGauge size={15} />,
      value: measure(get(ID.odometer), 0) ?? '--',
      detail: measure(get(ID.distanceToService), 0) ? `${measure(get(ID.distanceToService), 0)} to service` : 'Service distance unknown',
    },
    {
      entityId: ID.lock,
      label: 'Locks',
      icon: 'lock',
      tone: locked === false ? 'tone-lock is-unlocked' : locked ? 'tone-lock is-locked' : 'tone-lock',
      kind: 'lock',
      glyph: locked === false ? <LockOpen size={15} /> : <Lock size={15} />,
      value: locked === null ? '--' : locked ? 'Locked' : 'Unlocked',
      detail: engineRunning ? 'Engine running' : openClosures.length > 0
        ? `${openClosures.length} open`
        : unreadClosures.length === closureItems.length ? 'Closures not reported' : 'All closed',
    },
  ]

  // The catch-all grid keeps this page zero-config: a sensor the integration adds
  // tomorrow still surfaces, without duplicating anything shown explicitly above.
  const shownIds = new Set<string>([
    ...Object.values(ID),
    ...TRIPS.flatMap((trip) => [trip.distance, trip.speed, trip.fuel, trip.energy].filter((value): value is string => Boolean(value))),
  ])
  const otherMetrics = car.metrics.filter((metric) => !shownIds.has(metric.entityId))

  const lastUpdated = car.updatedAt ? new Date(car.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '--'

  return (
    <section className="volvo-view" aria-label="Volvo">
      <header className="volvo-header">
        <div><Car size={17} /><h3>{car.deviceName}</h3></div>
        <span>
          Last update {lastUpdated}
          {relativeAge(car.updatedAt) ? ` · ${relativeAge(car.updatedAt)}` : ''}
          {' · '}{car.metrics.length + car.binaries.length} signals
        </span>
      </header>

      {/* Naming the connection state stops a sleeping car's last-known figures reading as live. */}
      {connection && !reachable && (
        <p className="volvo-banner is-asleep" role="status">
          <Moon size={13} />
          Car reports “{enumLabel(connection) ?? 'no connection'}” — figures below are the last values it sent.
        </p>
      )}

      <div className={`volvo-banner ${alerts > 0 ? 'is-attention' : 'is-clear'}`} role="status">
        {alerts > 0 ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
        {alerts > 0 ? (
          <span>
            {[
              locked === false ? 'unlocked' : null,
              openClosures.length > 0 ? `${openClosures.length} open` : null,
              tyreFaults.length > 0 ? `${tyreFaults.length} tyre warning${tyreFaults.length === 1 ? '' : 's'}` : null,
              fluidFaults.length > 0 ? `${fluidFaults.length} fluid low` : null,
              bulbFaults.length > 0 ? `${bulbFaults.length} bulb out` : null,
              serviceWarning ? 'service due' : null,
            ].filter(Boolean).join(' · ')}
          </span>
        ) : (
          <span>Locked, closed and no warnings{unreadClosures.length > 0 ? ` · ${unreadClosures.length} sensor${unreadClosures.length === 1 ? '' : 's'} not reporting` : ''}</span>
        )}
      </div>

      <div className="volvo-hero-row">
        {heroCards.map((card) => {
          const known = entities.has(card.entityId)
          return (
            <button
              key={card.entityId}
              type="button"
              className={`volvo-hero-card ${card.tone} ${known ? 'is-linked' : ''}`.trim()}
              onClick={known ? () => open(card.entityId, card.label, card.icon, card.kind) : undefined}
              disabled={!known}
              title={known ? `Open ${card.label} history` : `${card.label} is unavailable`}
            >
              <span>{card.glyph} {card.label}</span>
              <strong>{card.value}</strong>
              <small>{card.detail}</small>
            </button>
          )
        })}
      </div>

      <div className="volvo-panel-row">
        <section className="volvo-panel" aria-label="Doors, windows and body">
          <div className="volvo-panel-head">
            <DoorOpen size={15} />
            <h4>Closures</h4>
            <span className={openClosures.length > 0 ? 'is-attention' : undefined}>
              {openClosures.length > 0 ? `${openClosures.length} open` : unreadClosures.length === closureItems.length ? 'Not reported' : 'All closed'}
            </span>
          </div>
          {CLOSURES.map((group) => (
            <div key={group.group} className="volvo-closure-group">
              <h5>{group.group}</h5>
              <div className="volvo-closure-cells">
                {group.items.map((item) => {
                  const state = openness(get(item.entityId))
                  return (
                    <button
                      key={item.entityId}
                      type="button"
                      className={`volvo-cell is-${state}`}
                      onClick={() => open(item.entityId, `${group.group} ${item.label}`, 'door-open')}
                      disabled={!entities.has(item.entityId)}
                      title={`${item.label}: ${state === 'unknown' ? 'not reported' : state}`}
                    >
                      <em>{item.label}</em>
                      <b>{state === 'open' ? 'Open' : state === 'closed' ? 'Closed' : '—'}</b>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
          <div className="volvo-closure-group">
            <h5>Central lock</h5>
            <div className="volvo-closure-cells">
              <button
                type="button"
                className={`volvo-cell is-wide ${locked === false ? 'is-open' : locked ? 'is-closed' : 'is-unknown'}`}
                onClick={() => open(ID.lock, 'Central lock', 'lock', 'lock')}
                disabled={!entities.has(ID.lock)}
              >
                <em>Doors</em>
                <b>{locked === null ? '—' : locked ? 'Locked' : 'Unlocked'}</b>
              </button>
            </div>
          </div>
        </section>

        <section className="volvo-panel" aria-label="Tyre pressure warnings">
          <div className="volvo-panel-head">
            <Disc3 size={15} />
            <h4>Tyres</h4>
            <span className={tyreFaults.length > 0 ? 'is-attention' : undefined}>
              {tyreFaults.length > 0 ? `${tyreFaults.length} low` : tyreUnread.length === TYRES.length ? 'Not reported' : 'All nominal'}
            </span>
          </div>
          {/* Laid out as the car sits on the road, so "rear left" needs no reading. */}
          <div className="volvo-tyre-plan">
            {TYRES.map((tyre) => {
              const state = health(get(tyre.entityId))
              return (
                <button
                  key={tyre.entityId}
                  type="button"
                  className={`volvo-tyre is-${state}`}
                  onClick={() => open(tyre.entityId, `Tyre ${tyre.label}`, 'gauge')}
                  disabled={!entities.has(tyre.entityId)}
                  title={`${tyre.label}: ${state === 'problem' ? 'low pressure' : state === 'ok' ? 'nominal' : 'not reported'}`}
                >
                  <em>{tyre.label}</em>
                  <b>{state === 'problem' ? 'Low' : state === 'ok' ? 'OK' : '—'}</b>
                </button>
              )
            })}
          </div>
          <p className="volvo-note">
            The car reports pressure <strong>warnings</strong>, not psi values — there is no pressure reading to show.
          </p>
        </section>
      </div>

      <div className="volvo-panel-row">
        <section className="volvo-panel" aria-label="Trip and efficiency">
          <div className="volvo-panel-head">
            <Route size={15} />
            <h4>Trip &amp; efficiency</h4>
            <span>{measure(get(ID.odometer), 0) ? `${measure(get(ID.odometer), 0)} total` : 'Odometer unknown'}</span>
          </div>
          <div className="volvo-trip-grid">
            {TRIPS.map((trip) => (
              <div key={trip.column} className="volvo-trip-column">
                <h5>{trip.column}</h5>
                {[
                  { entityId: trip.distance, label: 'Distance', digits: 1 },
                  { entityId: trip.speed, label: 'Avg speed', digits: 1 },
                  { entityId: trip.fuel, label: 'Fuel use', digits: 2 },
                  { entityId: trip.energy, label: 'Energy use', digits: 1 },
                ].map((row) => {
                  if (!row.entityId) return null
                  const entity = get(row.entityId)
                  const value = measure(entity, row.digits)
                  return (
                    <button
                      key={row.entityId}
                      type="button"
                      className="volvo-stat"
                      onClick={() => open(row.entityId as string, `${trip.column} ${row.label}`, 'gauge')}
                      disabled={!entities.has(row.entityId)}
                    >
                      <em>{row.label}</em>
                      <b className={value ? undefined : 'is-blank'}>{value ?? 'No reading'}</b>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </section>

        <section className="volvo-panel" aria-label="Service and health">
          <div className="volvo-panel-head">
            <Wrench size={15} />
            <h4>Service &amp; health</h4>
            <span className={serviceWarning ? 'is-attention' : undefined}>{enumLabel(get(ID.service)) ?? 'Not reported'}</span>
          </div>
          <div className="volvo-stat-grid">
            {[
              { entityId: ID.distanceToService, label: 'To service', digits: 0 },
              { entityId: ID.timeToService, label: 'Service in', digits: 0 },
              { entityId: ID.timeToEngineService, label: 'Engine service', digits: 0 },
            ].map((row) => {
              const value = measure(get(row.entityId), row.digits)
              return (
                <button
                  key={row.entityId}
                  type="button"
                  className="volvo-stat"
                  onClick={() => open(row.entityId, row.label, 'gauge')}
                  disabled={!entities.has(row.entityId)}
                >
                  <em>{row.label}</em>
                  <b className={value ? undefined : 'is-blank'}>{value ?? 'No reading'}</b>
                </button>
              )
            })}
          </div>

          <div className="volvo-chip-block">
            <h5><Droplets size={12} /> Fluids</h5>
            <div className="volvo-chips">
              {FLUIDS.map((fluid) => {
                const state = health(get(fluid.entityId))
                return (
                  <button
                    key={fluid.entityId}
                    type="button"
                    className={`volvo-chip is-${state}`}
                    onClick={() => open(fluid.entityId, `${fluid.label} level`, 'droplets')}
                    disabled={!entities.has(fluid.entityId)}
                  >
                    {state === 'problem' ? <CircleAlert size={11} /> : state === 'ok' ? <CircleCheck size={11} /> : null}
                    {fluid.label}
                    {state === 'problem' && <i>low</i>}
                    {state === 'unknown' && <i>—</i>}
                  </button>
                )
              })}
            </div>
          </div>

          {bulbs.length > 0 && (
            <div className="volvo-chip-block">
              <h5><Lightbulb size={12} /> Bulbs</h5>
              <div className="volvo-chips">
                {/* Twenty "Off" chips is noise; only failures earn a chip, the rest collapse to a count. */}
                {bulbFaults.length === 0 ? (
                  <span className="volvo-chip is-ok"><CircleCheck size={11} />{bulbs.length} monitored, none out</span>
                ) : bulbFaults.map((bulb) => (
                  <button
                    key={bulb.entity_id}
                    type="button"
                    className="volvo-chip is-problem"
                    onClick={() => open(bulb.entity_id, String(bulb.attributes.friendly_name ?? bulb.entity_id), 'lightbulb')}
                  >
                    <CircleAlert size={11} />
                    {String(bulb.attributes.friendly_name ?? bulb.entity_id).replace(/^Volvo\s*XC60\s*/i, '')}
                    <i>out</i>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="volvo-chip-block">
            <h5><Car size={12} /> Car</h5>
            <div className="volvo-chips">
              <button
                type="button"
                className={`volvo-chip ${engineRunning ? 'is-problem' : 'is-ok'}`}
                onClick={() => open(ID.engine, 'Engine status', 'car')}
                disabled={!entities.has(ID.engine)}
              >
                {engineRunning ? 'Engine running' : live(get(ID.engine)) ? 'Engine off' : 'Engine —'}
              </button>
              <button
                type="button"
                className={`volvo-chip ${reachable ? 'is-ok' : 'is-unknown'}`}
                onClick={() => open(ID.connection, 'Car connection', 'wifi')}
                disabled={!entities.has(ID.connection)}
              >
                {enumLabel(connection) ?? 'Connection —'}
              </button>
              <button
                type="button"
                className={`volvo-chip ${plugged ? 'is-ok' : 'is-unknown'}`}
                onClick={() => open(ID.chargingPowerStatus, 'Charging power status', 'battery')}
                disabled={!entities.has(ID.chargingPowerStatus)}
              >
                {enumLabel(get(ID.chargingPowerStatus)) ?? 'Charge point —'}
              </button>
            </div>
          </div>
        </section>
      </div>

      {otherMetrics.length > 0 && (
        <div className="volvo-metric-grid">
          {otherMetrics.map((metric) => (
            <button
              key={metric.entityId}
              type="button"
              className="volvo-metric-card"
              onClick={() => open(metric.entityId, metric.label, 'gauge')}
            >
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
            </button>
          ))}
        </div>
      )}

      <div className="volvo-chart-row">
        <TrendChart title="Battery" entityId={entities.has(ID.battery) ? ID.battery : null} color="#39df8b" unit={unitOf(battery)} />
        <TrendChart title="Electric range" entityId={entities.has(ID.rangeBattery) ? ID.rangeBattery : null} color="#55a8ff" unit={unitOf(get(ID.rangeBattery))} />
        <TrendChart title="Charging power" entityId={entities.has(ID.chargingPower) ? ID.chargingPower : null} color="#f5b544" unit={unitOf(get(ID.chargingPower))} />
      </div>
    </section>
  )
}
