import { memo, useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  BatteryCharging, Car, CircleAlert, CircleCheck, CircleGauge, Disc3, DoorOpen, Droplets, Fuel, Gauge,
  Lightbulb, Lock, LockOpen, MapPinned, Moon, Plug, Route, ShieldAlert, ShieldCheck, Wrench,
} from 'lucide-react'
import { isAbortError } from './cachedFetch'
import { GlassTooltip } from './chartKit'
import { chartMargin, gridProps, lineProps, seriesColor, tooltipCursor, xAxisProps, yAxisProps } from './chartTheme'
import { friendlyName } from './entityNames'
import { fetchHistory, parseHistoryStates } from './history'
import type { HistoryPoint } from './history'
import type { HAEntity, TileConfig, TileKind } from './types'
import { EmptyState, InlineError, LoadingState } from './ui/StateMessages'
import { PageFrame } from './ui/PageFrame'
import type { Tone } from './ui/PageFrame'
import { useVolvo } from './useVolvo'
import './VolvoView.css'

interface VolvoViewProps {
  entities: Map<string, HAEntity>
  /** Opens the shared entity detail sheet, same as tiles in every other section. */
  onExpand: (tile: TileConfig) => void
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

/** The car page re-mounts every rotation; a five-minute-old chart of a parked car is the same chart. */
const HISTORY_TTL_MS = 5 * 60_000

/** 24-hour history for one metric, from the shared history cache -- the full series, not the sparkline thumbnail. */
function useHistory(entityId: string | null) {
  const [points, setPoints] = useState<HistoryPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!entityId) return
    const abort = new AbortController()
    let stopped = false
    queueMicrotask(() => { if (!stopped) { setLoading(true); setFailed(false) } })
    fetchHistory(entityId, 24, HISTORY_TTL_MS, abort.signal)
      .then((payload) => { if (!stopped) setPoints(parseHistoryStates(payload)) })
      .catch((error: unknown) => {
        if (isAbortError(error) || stopped) return
        // The previous chart (if any) stays up; failures are not cached, so a retry refetches.
        setFailed(true)
      })
      .finally(() => { if (!stopped) setLoading(false) })
    return () => { stopped = true; abort.abort() }
  }, [entityId, attempt])

  const reload = useCallback(() => setAttempt((value) => value + 1), [])
  return { points, loading, failed, reload }
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric' })
}

function formatClock(value: string | number) {
  return new Date(Number(value)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

const chartNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value))
}

// Every prop is a primitive, so the three charts sit out the WebSocket-driven re-renders of the page around them.
const TrendChart = memo(function TrendChart({ title, entityId, unit }: { title: string; entityId: string | null; unit: string }) {
  const { points, loading, failed, reload } = useHistory(entityId)
  // Each chart carries one measure, so each takes the first series colour rather than implying
  // three related series by colouring them apart.
  const color = seriesColor(0)

  let body: ReactNode
  if (points.length > 1) {
    body = (
      <div className="volvo-chart-body" data-swipe-ignore>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={chartMargin}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} tickFormatter={formatTime} minTickGap={38} {...xAxisProps} />
            <YAxis domain={['auto', 'auto']} {...yAxisProps} />
            <Tooltip
              cursor={tooltipCursor}
              content={<GlassTooltip labelFormat={formatClock} valueFormat={(value) => `${chartNumber.format(value)}${unit ? ` ${unit}` : ''}`} />}
            />
            <Area type="monotone" dataKey="value" name={title} stroke={color} fill={color} fillOpacity={0.1} connectNulls isAnimationActive={false} {...lineProps} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    )
  } else if (!entityId) {
    body = <EmptyState size="compact" icon={<Gauge />} title="No matching sensor" />
  } else if (failed) {
    body = <InlineError message="Could not load history" onRetry={reload} />
  } else if (loading) {
    body = <LoadingState size="compact" label="Loading history" />
  } else {
    body = <EmptyState size="compact" icon={<Gauge />} title="Not enough history yet" hint="Needs two readings in the last 24 hours." />
  }

  return (
    <section className="volvo-chart glass glass-card" aria-label={title}>
      <header className="volvo-card-head">
        <Gauge size={15} aria-hidden="true" />
        <h3>{title}</h3>
        {entityId && points.length > 1 && <span>{points.length} readings · 24h</span>}
      </header>
      {body}
    </section>
  )
})

function sentence(text: string) {
  return text.replace(/^./, (character) => character.toUpperCase())
}

export function VolvoView({ entities, onExpand }: VolvoViewProps) {
  const car = useVolvo(entities)

  if (!car) {
    // An empty map means the socket has not delivered its first snapshot yet, not that there is no car.
    if (entities.size === 0) {
      return (
        <PageFrame className="volvo-view" icon={<Car />} title="Connecting">
          <LoadingState label="Waiting for Home Assistant" />
        </PageFrame>
      )
    }
    return (
      <PageFrame className="volvo-view" icon={<Car />} title="No car connected">
        <EmptyState
          icon={<Car />}
          title="No Volvo entities found"
          hint="Looks for sensor.*, binary_sensor.* and lock.* entities with “volvo” in their ID, from the Volvo Cars integration. This page fills in on its own once they appear."
        />
      </PageFrame>
    )
  }

  const get = (entityId: string) => entities.get(entityId)
  const open = (entityId: string, label: string, icon: string, kind: TileKind = 'sensor') => {
    if (entities.has(entityId)) onExpand({ entityId, label, kind, icon })
  }

  const battery = get(ID.battery)
  const batteryPercent = numberOf(battery)
  const targetPercent = numberOf(get(ID.targetCharge))
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
  const electricRange = numberOf(get(ID.rangeBattery))
  const fuelRange = numberOf(get(ID.rangeTank))

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
    tone?: Tone
    kind?: TileKind
    glyph: ReactNode
    value: string
    detail: string
    /** A recessed fill for figures that are a share of something, so the proportion reads at a glance. */
    meter?: { percent: number; label: string; target?: number | null }
  }[] = [
    {
      entityId: ID.battery,
      label: 'Battery',
      icon: 'battery',
      glyph: <BatteryCharging size={15} />,
      value: measure(battery, 0) ?? '--',
      detail: [measure(get(ID.batteryCapacity), 1), measure(get(ID.targetCharge), 0) ? `target ${measure(get(ID.targetCharge), 0)}` : null]
        .filter(Boolean).join(' · ') || 'No reading',
      meter: batteryPercent === null ? undefined : { percent: clampPercent(batteryPercent), label: 'Battery charge', target: targetPercent },
    },
    {
      entityId: ID.rangeBattery,
      label: 'Electric range',
      icon: 'gauge',
      glyph: <MapPinned size={15} />,
      value: measure(get(ID.rangeBattery), 0) ?? '--',
      detail: measure(get(ID.rangeTank), 0) ? `${measure(get(ID.rangeTank), 0)} on fuel` : 'Fuel range unknown',
      // The range sensors have no stated maximum, so the bar shows the electric share of the
      // combined range: the one proportion the car's own figures fully define.
      meter: electricRange !== null && fuelRange !== null && electricRange + fuelRange > 0
        ? { percent: clampPercent((electricRange / (electricRange + fuelRange)) * 100), label: 'Electric share of total range' }
        : undefined,
    },
    {
      entityId: ID.rangeTank,
      label: 'Fuel',
      icon: 'droplets',
      glyph: <Fuel size={15} />,
      value: measure(get(ID.fuelAmount), 1) ?? '--',
      detail: measure(get(ID.rangeTank), 0) ? `${measure(get(ID.rangeTank), 0)} range` : 'No reading',
    },
    {
      entityId: ID.chargingStatus,
      label: 'Charging',
      icon: 'battery',
      tone: chargingNow ? 'good' : undefined,
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
      glyph: <CircleGauge size={15} />,
      value: measure(get(ID.odometer), 0) ?? '--',
      detail: measure(get(ID.distanceToService), 0) ? `${measure(get(ID.distanceToService), 0)} to service` : 'Service distance unknown',
    },
    {
      entityId: ID.lock,
      label: 'Locks',
      icon: 'lock',
      tone: locked === false ? 'danger' : undefined,
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

  // The sub-heading answers the two questions asked of a parked car: is it locked, and how full is it.
  const securityWord = engineRunning ? 'Engine running' : locked === null ? null : locked ? 'Locked' : 'Unlocked'
  const chargeWord = batteryPercent === null ? null : chargingNow
    ? `Charging · ${Math.round(batteryPercent)}%`
    : `${Math.round(batteryPercent)}% charged`
  const title = [securityWord, chargeWord].filter(Boolean).join(' · ') || car.deviceName
  const pageTone: Tone = alerts > 0 ? 'warn' : locked ? 'good' : 'neutral'

  const attention = [
    locked === false ? 'unlocked' : null,
    openClosures.length > 0 ? `${openClosures.length} open` : null,
    tyreFaults.length > 0 ? `${tyreFaults.length} tyre warning${tyreFaults.length === 1 ? '' : 's'}` : null,
    fluidFaults.length > 0 ? `${fluidFaults.length} fluid low` : null,
    bulbFaults.length > 0 ? `${bulbFaults.length} bulb out` : null,
    serviceWarning ? 'service due' : null,
  ].filter(Boolean).join(' · ')

  return (
    <PageFrame
      className="volvo-view"
      icon={<Car />}
      eyebrow={car.deviceName}
      title={title}
      tone={pageTone}
      meta={`Updated ${lastUpdated}${relativeAge(car.updatedAt) ? ` · ${relativeAge(car.updatedAt)}` : ''} · ${car.metrics.length + car.binaries.length} signals`}
    >
      {/* Naming the connection state stops a sleeping car's last-known figures reading as live. */}
      {connection && !reachable && (
        <p className="volvo-banner is-asleep" role="status">
          <Moon size={15} aria-hidden="true" />
          <span>Car reports “{enumLabel(connection) ?? 'no connection'}”. Figures below are the last values it sent.</span>
        </p>
      )}

      <p className={`volvo-banner ${alerts > 0 ? 'is-attention' : 'is-clear'}`} role="status">
        {alerts > 0 ? <ShieldAlert size={15} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}
        {alerts > 0 ? (
          <span>{sentence(attention)}</span>
        ) : (
          <span>Locked, closed and no warnings{unreadClosures.length > 0 ? ` · ${unreadClosures.length} sensor${unreadClosures.length === 1 ? '' : 's'} not reporting` : ''}</span>
        )}
      </p>

      <div className="volvo-hero-row">
        {heroCards.map((card) => {
          const known = entities.has(card.entityId)
          return (
            <button
              key={card.entityId}
              type="button"
              className={`volvo-hero-card glass glass-card${card.tone ? ` tone-${card.tone}` : ''}`}
              onClick={known ? () => open(card.entityId, card.label, card.icon, card.kind) : undefined}
              disabled={!known}
              title={known ? `Open ${card.label} history` : `${card.label} is unavailable`}
            >
              <span className="volvo-hero-label">{card.glyph} {card.label}</span>
              <strong>{card.value}</strong>
              {card.meter && (
                <span
                  className="volvo-meter glass-inset"
                  role="meter"
                  aria-label={card.meter.label}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(card.meter.percent)}
                >
                  <i style={{ width: `${card.meter.percent}%` }} />
                  {card.meter.target != null && card.meter.target > 0 && card.meter.target < 100 && (
                    <b style={{ left: `${card.meter.target}%` }} aria-hidden="true" />
                  )}
                </span>
              )}
              <small>{card.detail}</small>
            </button>
          )
        })}
      </div>

      <div className="volvo-panel-row">
        <section className="volvo-panel glass glass-card" aria-label="Doors, windows and body">
          <header className="volvo-card-head">
            <DoorOpen size={15} aria-hidden="true" />
            <h3>Closures</h3>
            <span className={openClosures.length > 0 ? 'is-attention' : undefined}>
              {openClosures.length > 0 ? `${openClosures.length} open` : unreadClosures.length === closureItems.length ? 'Not reported' : 'All closed'}
            </span>
          </header>
          {CLOSURES.map((group) => (
            <div key={group.group} className="volvo-closure-group">
              <h4>{group.group}</h4>
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
            <h4>Central lock</h4>
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

        <section className="volvo-panel glass glass-card" aria-label="Tyre pressure warnings">
          <header className="volvo-card-head">
            <Disc3 size={15} aria-hidden="true" />
            <h3>Tyres</h3>
            <span className={tyreFaults.length > 0 ? 'is-attention' : undefined}>
              {tyreFaults.length > 0 ? `${tyreFaults.length} low` : tyreUnread.length === TYRES.length ? 'Not reported' : 'All nominal'}
            </span>
          </header>
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
            The car reports pressure <strong>warnings</strong>, not psi values, so there is no pressure reading to show.
          </p>
        </section>
      </div>

      <div className="volvo-panel-row">
        <section className="volvo-panel glass glass-card" aria-label="Trip and efficiency">
          <header className="volvo-card-head">
            <Route size={15} aria-hidden="true" />
            <h3>Trip &amp; efficiency</h3>
            <span>{measure(get(ID.odometer), 0) ? `${measure(get(ID.odometer), 0)} total` : 'Odometer unknown'}</span>
          </header>
          <div className="volvo-trip-grid">
            {TRIPS.map((trip) => (
              <div key={trip.column} className="volvo-trip-column">
                <h4>{trip.column}</h4>
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

        <section className="volvo-panel glass glass-card" aria-label="Service and health">
          <header className="volvo-card-head">
            <Wrench size={15} aria-hidden="true" />
            <h3>Service &amp; health</h3>
            <span className={serviceWarning ? 'is-attention' : undefined}>{enumLabel(get(ID.service)) ?? 'Not reported'}</span>
          </header>
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
            <h4><Droplets size={13} aria-hidden="true" /> Fluids</h4>
            <div className="volvo-chips">
              {FLUIDS.map((fluid) => {
                const state = health(get(fluid.entityId))
                return (
                  <button
                    key={fluid.entityId}
                    type="button"
                    className={`volvo-chip glass-pill is-${state}`}
                    onClick={() => open(fluid.entityId, `${fluid.label} level`, 'droplets')}
                    disabled={!entities.has(fluid.entityId)}
                  >
                    {state === 'problem' ? <CircleAlert size={13} aria-hidden="true" /> : state === 'ok' ? <CircleCheck size={13} aria-hidden="true" /> : null}
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
              <h4><Lightbulb size={13} aria-hidden="true" /> Bulbs</h4>
              <div className="volvo-chips">
                {/* Twenty "Off" chips is noise; only failures earn a chip, the rest collapse to a count. */}
                {bulbFaults.length === 0 ? (
                  <span className="volvo-chip glass-pill is-ok"><CircleCheck size={13} aria-hidden="true" />{bulbs.length} monitored, none out</span>
                ) : bulbFaults.map((bulb) => (
                  <button
                    key={bulb.entity_id}
                    type="button"
                    className="volvo-chip glass-pill is-problem"
                    onClick={() => open(bulb.entity_id, friendlyName(bulb, bulb.entity_id), 'lightbulb')}
                  >
                    <CircleAlert size={13} aria-hidden="true" />
                    {friendlyName(bulb, bulb.entity_id).replace(/^Volvo\s*XC60\s*/i, '')}
                    <i>out</i>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="volvo-chip-block">
            <h4><Car size={13} aria-hidden="true" /> Car</h4>
            <div className="volvo-chips">
              <button
                type="button"
                className={`volvo-chip glass-pill ${engineRunning ? 'is-problem' : 'is-ok'}`}
                onClick={() => open(ID.engine, 'Engine status', 'car')}
                disabled={!entities.has(ID.engine)}
              >
                {engineRunning ? 'Engine running' : live(get(ID.engine)) ? 'Engine off' : 'Engine —'}
              </button>
              <button
                type="button"
                className={`volvo-chip glass-pill ${reachable ? 'is-ok' : 'is-unknown'}`}
                onClick={() => open(ID.connection, 'Car connection', 'wifi')}
                disabled={!entities.has(ID.connection)}
              >
                {enumLabel(connection) ?? 'Connection —'}
              </button>
              <button
                type="button"
                className={`volvo-chip glass-pill ${plugged ? 'is-ok' : 'is-unknown'}`}
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
        <section className="volvo-other glass glass-card" aria-label="Other signals">
          <header className="volvo-card-head">
            <Gauge size={15} aria-hidden="true" />
            <h3>Other signals</h3>
            <span>{otherMetrics.length}</span>
          </header>
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
        </section>
      )}

      <div className="volvo-chart-row">
        <TrendChart title="Battery" entityId={entities.has(ID.battery) ? ID.battery : null} unit={unitOf(battery)} />
        <TrendChart title="Electric range" entityId={entities.has(ID.rangeBattery) ? ID.rangeBattery : null} unit={unitOf(get(ID.rangeBattery))} />
        <TrendChart title="Charging power" entityId={entities.has(ID.chargingPower) ? ID.chargingPower : null} unit={unitOf(get(ID.chargingPower))} />
      </div>
    </PageFrame>
  )
}
