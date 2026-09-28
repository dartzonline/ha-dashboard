import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AlertTriangle, ArrowDown, ArrowUp, Battery, BellRing, Bot, ChartNoAxesCombined, ChevronDown, CloudSun,
  History, Info, KeyRound, Lightbulb, Lock, LockOpen, Menu, MonitorSmartphone, Moon, PanelLeftClose, Pause, Play,
  RotateCw, Send, Shield, SkipBack, SkipForward, Square, SunMedium, Thermometer, Volume2, Wifi, WifiOff, Wind,
  Wrench, X,
} from 'lucide-react'
import './App.css'
import { icons, sectionIcons } from './icons'
import type { HAEntity, TileConfig } from './types'
import { useHomeAssistant } from './useHomeAssistant'
import type { HAStateChange } from './useHomeAssistant'
import { useInsights } from './useInsights'
import { useDashboardConfig } from './useDashboardConfig'
import { insightsSlides, rotationInterval } from './insightsSlides'
import { flightsSlideCount } from './flightsSlides'
import { ConfigPanel } from './ConfigPanel'
import { EventLog } from './EventLog'
import { useEventLog } from './useEventLog'
import { PhotoBackdrop } from './PhotoBackdrop'
import { usePhotoLibrary } from './photoLibrary'
import { PresenceRow } from './PresenceRow'
import { SecurityPanel } from './SecurityPanel'
import { Sparkline } from './Sparkline'
import { useSparkline } from './useSparkline'
import { StateTimeline } from './StateTimeline'
import { ConnectionStatus } from './ConnectionStatus'
import { ThermostatKnob } from './ThermostatKnob'
import { TrackedAircraftBadge } from './TrackedAircraftBadge'
import { useAutoDim } from './useAutoDim'
import { WeatherView } from './WeatherView'
import { WorldTimeMap } from './WorldTimeMap'
import { friendlyName } from './entityNames'
import { formatNumber, isThroughputUnit, toMbps } from './units'
import { clampSlide, parseShellHash, readRotationHold, shellHash, writeRotationHold } from './urlState'
import { PageFrame } from './ui/PageFrame'
import { LoadingState } from './ui/StateMessages'
import { useBackToClose } from './ui/useBackToClose'
import { useDialog } from './ui/useDialog'
import { useMediaQuery } from './ui/useMediaQuery'
import { useTwoTapConfirm } from './ui/useTwoTapConfirm'

const InsightsView = lazy(() => import('./InsightsView').then((module) => ({ default: module.InsightsView })))
const EntityHistory = lazy(() => import('./EntityHistory').then((module) => ({ default: module.EntityHistory })))
const EnergyView = lazy(() => import('./EnergyView').then((module) => ({ default: module.EnergyView })))
const VolvoView = lazy(() => import('./VolvoView').then((module) => ({ default: module.VolvoView })))
const FlightsView = lazy(() => import('./FlightsView').then((module) => ({ default: module.FlightsView })))
const NetworkDetail = lazy(() => import('./NetworkDetail').then((module) => ({ default: module.NetworkDetail })))
const NetworkView = lazy(() => import('./NetworkView').then((module) => ({ default: module.NetworkView })))
const HealthView = lazy(() => import('./HealthView').then((module) => ({ default: module.HealthView })))
const MaintenanceView = lazy(() => import('./MaintenanceView').then((module) => ({ default: module.MaintenanceView })))
const PhotosView = lazy(() => import('./PhotosView').then((module) => ({ default: module.PhotosView })))
const RoborockView = lazy(() => import('./RoborockView').then((module) => ({ default: module.RoborockView })))

/** The WAN sensor is a plain on/off, so its detail sheet gets the router's throughput story instead. */
function isNetworkEntity(entityId: string, entity: HAEntity | undefined) {
  return entityId === 'binary_sensor.cbr750_gateway_wan_status'
    || (String(entity?.attributes.device_class ?? '') === 'connectivity' && /wan|internet|gateway/i.test(entityId))
}

/**
 * "leak detected" -> "Leak detected", "heat_cool" -> "Heat cool". Done in code rather than with
 * `text-transform: capitalize`, which also capitalised units ("kWh" -> "KWh") and every word of a
 * phrase. Anything starting with a digit is a reading and is left exactly as it is.
 */
function sentenceCase(text: string) {
  const spaced = text.replaceAll('_', ' ').trim()
  if (!spaced || /^[-+]?\d/.test(spaced)) return spaced
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function formatEntityState(entity: HAEntity, state: string) {
  const domain = entity.entity_id.split('.')[0]
  const deviceClass = String(entity.attributes.device_class ?? '')
  let word = state
  if (domain === 'binary_sensor') {
    if (['door', 'garage_door', 'window', 'opening'].includes(deviceClass)) word = state === 'on' ? 'open' : state === 'off' ? 'closed' : state
    else if (deviceClass === 'moisture') word = state === 'on' ? 'leak detected' : state === 'off' ? 'dry' : state
    else if (deviceClass === 'motion' || deviceClass === 'occupancy') word = state === 'on' ? 'detected' : state === 'off' ? 'clear' : state
    else if (['smoke', 'gas', 'problem', 'safety'].includes(deviceClass)) word = state === 'on' ? 'detected' : state === 'off' ? 'clear' : state
  }
  return sentenceCase(word)
}

function displayState(entity: HAEntity | undefined) {
  if (!entity) return 'Unavailable'
  const numericValue = Number(entity.state)
  const unit = typeof entity.attributes.unit_of_measurement === 'string'
    ? entity.attributes.unit_of_measurement
    : ''
  if (entity.state.trim() !== '' && Number.isFinite(numericValue)) {
    if (isThroughputUnit(unit)) return `${formatNumber(toMbps(numericValue, unit), 1)} Mbps`
    const digits = unit === '%' ? 0 : 1
    return `${formatNumber(numericValue, digits)}${unit ? ` ${unit}` : ''}`
  }
  return formatEntityState(entity, entity.state)
}

function isActive(entity: HAEntity | undefined) {
  return Boolean(entity && ['on', 'open', 'unlocked', 'playing', 'cleaning', 'returning'].includes(entity.state))
}

function isHazard(entity: HAEntity | undefined) {
  if (!entity) return false
  const domain = entity.entity_id.split('.')[0]
  const deviceClass = String(entity.attributes.device_class ?? '')
  if (entity.entity_id.includes('doors_open') && Number(entity.state) > 0) return true
  if (domain === 'lock') return ['unlocked', 'jammed', 'open'].includes(entity.state)
  if (domain === 'cover') return ['open', 'opening'].includes(entity.state)
  return domain === 'binary_sensor' && entity.state === 'on' && ['door', 'garage_door', 'window', 'opening', 'moisture', 'smoke', 'gas', 'problem', 'safety'].includes(deviceClass)
}

const doorOpeningClasses = ['door', 'garage_door', 'window', 'opening']

/**
 * A count sensor has nothing worth charting, so the Doors tile leads with the plain-language
 * verdict ("Open"/"Closed") and the count, then names which doors are open.
 */
function openDoorSummary(entities: Map<string, HAEntity>): string {
  const doorSensors = Array.from(entities.values()).filter((entity) => {
    const deviceClass = String(entity.attributes.device_class ?? '')
    return entity.entity_id.startsWith('binary_sensor.') && doorOpeningClasses.includes(deviceClass)
  })
  const open = doorSensors.filter((entity) => entity.state === 'on')
  // The helper sensor can know about doors this dashboard has no binary_sensor for, so trust
  // whichever source reports more open.
  const reported = Number(entities.get('sensor.doors_open_count')?.state)
  const openCount = Math.max(Number.isFinite(reported) ? reported : 0, open.length)

  if (openCount === 0) {
    return doorSensors.length ? `Closed · all ${doorSensors.length} secure` : 'Closed · 0 open'
  }

  const label = `Open · ${openCount} door${openCount === 1 ? '' : 's'}`
  if (!open.length) return label
  const names = open.map((entity) => friendlyName(entity))
  const shown = names.slice(0, 2).join(', ')
  return names.length > 2 ? `${label}: ${shown} +${names.length - 2} more` : `${label}: ${shown}`
}

interface StateAlert {
  id: number
  title: string
  message: string
  tone: 'info' | 'critical' | 'success'
}

/** How long an interaction holds the current page before rotation picks itself back up. */
const AUTO_RESUME_MS = 90_000

/** How long an untouched nav drawer stays open. Long enough to read eighteen labels and pick one. */
const SIDEBAR_IDLE_MS = 10_000

/** Weather and Flights step through their own slides faster than whole pages rotate. */
const SLIDE_INTERVAL_MS = 10_000
const WEATHER_SLIDE_COUNT = 4

/** Sections the unattended rotation passes over. They stay reachable from the sidebar and by swipe.
 *  `photos` is the photo *library manager* -- upload buttons and delete controls are not something
 *  to rotate an unattended wall panel onto; displaying the pictures themselves is separate. */
const ROTATION_EXCLUDED_SECTIONS = new Set(['scenes', 'photos'])

/** Anything with its own gesture: the page swipe must leave these alone. */
const SWIPE_IGNORE = 'input, [role="slider"], .thermo-knob, [data-swipe-ignore]'

const discreteDomains = new Set(['light', 'switch', 'lock', 'cover', 'media_player', 'vacuum'])
const alertingBinaryClasses = new Set(['door', 'garage_door', 'window', 'opening', 'moisture', 'smoke', 'gas', 'problem', 'safety'])

function createStateAlert(change: HAStateChange): StateAlert | null {
  const { entity, previousState } = change
  const domain = entity.entity_id.split('.')[0]
  const deviceClass = String(entity.attributes.device_class ?? '')
  if (!discreteDomains.has(domain) && !(domain === 'binary_sensor' && alertingBinaryClasses.has(deviceClass))) return null

  const title = friendlyName(entity)
  // One colour rule across every domain, so the palette is readable at a glance from across the
  // room without first working out what kind of device it was: anything that became open/on/
  // unlocked is red, anything that became closed/off/locked is green. Lights and switches are
  // deliberately included -- a light coming on at 3am is exactly the kind of thing worth noticing.
  const openState = ['on', 'open', 'opening', 'unlocked', 'jammed', 'problem'].includes(entity.state)
  const closedState = ['off', 'closed', 'locked', 'docked', 'idle'].includes(entity.state)
  return {
    id: change.id,
    title,
    message: `${formatEntityState(entity, previousState)} → ${formatEntityState(entity, entity.state)}`,
    tone: openState ? 'critical' : closedState ? 'success' : 'info',
  }
}

interface UtilityRailProps {
  entities: Map<string, HAEntity>
  activeSection: string
  autoRotate: boolean
  onSelect: (sectionId: string) => void
  onInspectSecurity: () => void
  now: Date
}

function UtilityRail({ entities, activeSection, autoRotate, onSelect, onInspectSecurity, now }: UtilityRailProps) {
  const [newDeviceIndex, setNewDeviceIndex] = useState(0)
  const all = Array.from(entities.values())
  const deviceClass = (entity: HAEntity) => String(entity.attributes.device_class ?? '')
  const nameOf = (entity: HAEntity) => friendlyName(entity)
  const numericState = (entity: HAEntity) => Number(entity.state)
  const outside = entities.get('sensor.open_weather_temperature') ?? all.find((entity) => deviceClass(entity) === 'temperature' && nameOf(entity).toLowerCase().includes('outside'))
  const humidity = entities.get('sensor.open_weather_humidity') ?? all.find((entity) => deviceClass(entity) === 'humidity' && nameOf(entity).toLowerCase().includes('outside'))
  const wind = entities.get('sensor.open_weather_windspeed') ?? all.find((entity) => deviceClass(entity) === 'wind_speed')
  const weather = entities.get('weather.forecast_home') ?? all.find((entity) => entity.entity_id.startsWith('weather.'))
  const locks = all.filter((entity) => entity.entity_id.startsWith('lock.'))
  const unsafeLocks = locks.filter((entity) => ['unlocked', 'open', 'jammed'].includes(entity.state))
  const doorSensors = all.filter((entity) => entity.entity_id.startsWith('binary_sensor.') && ['door', 'garage_door', 'window', 'opening'].includes(deviceClass(entity)))
  const openDoorSensors = doorSensors.filter((entity) => entity.state === 'on')
  const doorsEntity = entities.get('sensor.doors_open_count')
  const reportedDoors = Number(doorsEntity?.state)
  const openDoors = Math.max(Number.isFinite(reportedDoors) ? reportedDoors : 0, openDoorSensors.length)
  const leaks = all.filter((entity) => entity.entity_id.startsWith('binary_sensor.') && deviceClass(entity) === 'moisture' && entity.state === 'on')
  const networkEntity = entities.get('binary_sensor.cbr750_gateway_wan_status') ?? all.find((entity) => deviceClass(entity) === 'connectivity' && nameOf(entity).toLowerCase().includes('wan'))
  const downloadEntity = entities.get('sensor.cbr750_gateway_download_speed') ?? all.find((entity) => nameOf(entity).toLowerCase().includes('download speed'))
  const batteryEntity = entities.get('sensor.dashboard_battery_level') ?? all.find((entity) => deviceClass(entity) === 'battery' && /(dashboard|tablet)/i.test(nameOf(entity)))
  const vacuum = entities.get('vacuum.roborock_qrevo_maxv') ?? all.find((entity) => entity.entity_id.startsWith('vacuum.'))
  const lowBatteries = all
    .filter((entity) => deviceClass(entity) === 'battery' && Number.isFinite(numericState(entity)) && numericState(entity) <= 20)
    .sort((left, right) => numericState(left) - numericState(right))
  const activeProblems = all.filter((entity) => entity.entity_id.startsWith('binary_sensor.') && deviceClass(entity) === 'problem' && entity.state === 'on')
  const plants = all.filter((entity) => {
    const searchable = `${entity.entity_id} ${nameOf(entity)} ${deviceClass(entity)}`.toLowerCase()
    return Number.isFinite(numericState(entity)) && /(plant|soil|flower|garden|maple|magnolia)/.test(searchable) && /(humidity|moisture)/.test(searchable)
  })
  const dryPlants = plants.filter((entity) => numericState(entity) <= 20)
  // The router publishes one device_tracker per client, so online clients are counted from those states.
  const trackers = all.filter((entity) => entity.entity_id.startsWith('device_tracker.'))
  const onlineDevices = trackers.filter((entity) => entity.state === 'home')
  const awayDevices = trackers.filter((entity) => entity.state === 'not_home')
  const recentlyConnected = onlineDevices
    .filter((entity) => now.getTime() - Date.parse(entity.last_changed) < 30 * 60_000)
    .sort((left, right) => Date.parse(right.last_changed) - Date.parse(left.last_changed))
    .slice(0, 3)
  const newDevice = recentlyConnected.length ? recentlyConnected[newDeviceIndex % recentlyConnected.length] : undefined
  const securityIssues = unsafeLocks.length + openDoors + leaks.length
  const securityKnown = locks.length > 0 || doorSensors.length > 0 || Boolean(doorsEntity) || leaks.length > 0
  const networkOnline = networkEntity?.state === 'on'
  const weatherState = String(weather?.state ?? '').replace('partlycloudy', 'partly cloudy')
  const condition = weatherState ? sentenceCase(weatherState) : 'Weather'
  // Rail copy stays terse on purpose: six cells share one row at wall-panel type sizes, so a longer
  // phrase would just be truncated to an ellipsis and read as nothing at all.
  const securityDetail = unsafeLocks.length
    ? unsafeLocks.map(nameOf).slice(0, 1).join(' · ')
    : openDoors > 0
      ? `${openDoors} door${openDoors === 1 ? '' : 's'} open`
      : leaks.length > 0
        ? `${leaks.length} leak${leaks.length === 1 ? '' : 's'} detected`
        : securityKnown ? 'Locked · dry' : 'Checking sensors'
  const weatherDetail = [humidity ? displayState(humidity) : '', wind ? displayState(wind) : ''].filter(Boolean).join(' · ')
  const issueParts = [
    unsafeLocks.length ? `${unsafeLocks.length} unlocked lock${unsafeLocks.length === 1 ? '' : 's'}` : '',
    openDoors ? `${openDoors} open door${openDoors === 1 ? '' : 's'}` : '',
    leaks.length ? `${leaks.length} leak alert${leaks.length === 1 ? '' : 's'}` : '',
    activeProblems.length ? nameOf(activeProblems[0]) : '',
    lowBatteries.length ? `${nameOf(lowBatteries[0])} ${displayState(lowBatteries[0])}` : '',
    dryPlants.length ? `${nameOf(dryPlants[0])} ${displayState(dryPlants[0])}` : '',
  ].filter(Boolean)
  const issueCount = securityIssues + activeProblems.length + lowBatteries.length + dryPlants.length
  const attentionTarget = securityIssues > 0 ? 'security' : activeProblems.length ? 'roborock' : 'insights'
  const finalUtilityTitle = batteryEntity ? `Tablet ${displayState(batteryEntity)}` : vacuum ? `Vacuum ${displayState(vacuum)}` : 'Home systems'
  const finalUtilityDetail = autoRotate ? 'Rotating' : 'Rotate paused'

  useEffect(() => {
    if (recentlyConnected.length < 2) return
    const timer = window.setInterval(() => setNewDeviceIndex((current) => current + 1), 4_000)
    return () => window.clearInterval(timer)
  }, [recentlyConnected.length])

  const utilities = [
    { id: 'insights', target: 'insights', icon: ChartNoAxesCombined, title: 'Insights', detail: `${entities.size} live entities`, tone: 'accent' },
    {
      id: 'devices',
      target: 'insights',
      icon: MonitorSmartphone,
      title: trackers.length ? `${onlineDevices.length} online` : 'Devices',
      detail: newDevice
        ? `New: ${nameOf(newDevice)}`
        : trackers.length ? `${awayDevices.length} away · ${trackers.length} tracked` : 'No device trackers',
      tone: newDevice ? 'warn' : 'accent',
    },
    { id: 'security', target: 'security', icon: Shield, title: securityIssues > 0 ? `${securityIssues} security alert${securityIssues === 1 ? '' : 's'}` : securityKnown ? 'Secure' : 'Security', detail: securityDetail, tone: securityIssues > 0 ? 'danger' : securityKnown ? 'good' : 'muted', inspect: true },
    { id: 'weather', target: 'weather', icon: CloudSun, title: outside ? `${displayState(outside)} · ${condition}` : condition, detail: weatherDetail || 'Waiting for weather', tone: 'weather' },
    // Its own Network page exists now; this used to point at the generic Insights connectivity
    // slide because it was written before that page did.
    { id: 'network', target: 'network', icon: Wifi, title: networkOnline ? 'WAN online' : networkEntity ? 'WAN offline' : 'Network', detail: downloadEntity ? `${displayState(downloadEntity)} down` : 'Checking connection', tone: networkOnline ? 'good' : networkEntity ? 'danger' : 'muted' },
    // Battery reading -> Health, which is where every battery-class entity (this one included) is
    // actually listed; 'home' has nothing tablet-specific to land on.
    { id: 'tablet', target: batteryEntity ? 'health' : 'roborock', icon: batteryEntity ? Battery : Bot, title: finalUtilityTitle, detail: finalUtilityDetail, tone: 'accent' },
  ]

  return (
    <div className="utility-stack">
      <section className="utility-rail" aria-label="Home utility status">
        {utilities.map(({ id, target, icon: Icon, title, detail, tone, inspect }) => (
          // The tone colours the glyph; only a problem tints the whole pane. Three of six cells are
          // "accent" at any moment, and washing all of them made the rail read as a status board.
          <button
            type="button"
            key={id}
            className={`utility-cell glass is-${tone} ${tone === 'danger' ? 'tone-danger' : tone === 'warn' && id === 'devices' ? 'tone-warn' : ''} ${id === activeSection ? 'is-current' : ''}`}
            onClick={() => inspect ? onInspectSecurity() : onSelect(target)}
          >
            <span className="utility-icon"><Icon size={19} aria-hidden="true" /></span>
            <span className="utility-copy"><strong>{title}</strong><small key={detail}>{detail}</small></span>
          </button>
        ))}
      </section>
      <button
        type="button"
        className={`attention-strip glass ${issueCount > 0 ? 'has-issues tone-danger' : 'is-clear'}`}
        onClick={() => securityIssues > 0 ? onInspectSecurity() : onSelect(attentionTarget)}
      >
        <span><AlertTriangle size={17} aria-hidden="true" /></span>
        <strong>{entities.size === 0 ? 'Loading Home Assistant' : issueCount > 0 ? `${issueCount} item${issueCount === 1 ? '' : 's'} need attention` : 'All monitored systems normal'}</strong>
        <small>{entities.size === 0 ? 'Waiting for live entity states' : issueParts.length ? issueParts.join(' · ') : `${entities.size} entities reporting`}</small>
      </button>
    </div>
  )
}

interface TileProps {
  config: TileConfig
  entity?: HAEntity
  onService: (domain: string, service: string, data: Record<string, unknown>) => Promise<void>
  onExpand: () => void
  subtitle?: string
  noSparkline?: boolean
}

/** A press that travels further than this is a swipe or a scroll, not a long-press. */
const LONG_PRESS_SLOP_PX = 8
const LONG_PRESS_MS = 550

function EntityTile({ config, entity, onService, onExpand, subtitle, noSparkline }: TileProps) {
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const Icon = icons[config.icon] ?? Square
  const active = isActive(entity)
  const domain = config.entityId.split('.')[0]
  const lightOn = domain === 'light' && entity?.state === 'on'
  const hazard = isHazard(entity)
  // An entity that reports `unavailable` reads the same as a missing one, so it gets the same muted treatment.
  const offline = !entity || ['unavailable', 'unknown'].includes(entity.state)
  const showSparkline = !noSparkline && config.kind === 'sensor' && Boolean(entity) && Number.isFinite(Number(entity?.state))
  const sparkPoints = useSparkline(config.entityId, showSparkline)
  const press = useRef<{ x: number; y: number; timer: number } | null>(null)
  // Set when the press already did something (long-press opened the sheet) or turned into a drag,
  // so the click that follows the release does not open it a second time.
  const suppressClick = useRef(false)

  useEffect(() => () => {
    if (press.current) window.clearTimeout(press.current.timer)
  }, [])

  function cancelPress() {
    if (!press.current) return
    window.clearTimeout(press.current.timer)
    press.current = null
  }

  function startPress(event: React.PointerEvent) {
    cancelPress()
    suppressClick.current = false
    const timer = window.setTimeout(() => {
      press.current = null
      suppressClick.current = true
      onExpand()
    }, LONG_PRESS_MS)
    press.current = { x: event.clientX, y: event.clientY, timer }
  }

  function movePress(event: React.PointerEvent) {
    if (!press.current) return
    if (Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > LONG_PRESS_SLOP_PX) {
      cancelPress()
      suppressClick.current = true
    }
  }

  function openFromTap() {
    if (!suppressClick.current) onExpand()
    suppressClick.current = false
  }

  async function run(serviceDomain: string, service: string, extra: Record<string, unknown> = {}) {
    setPending(true)
    setMessage(null)
    try {
      await onService(serviceDomain, service, { entity_id: config.entityId, ...extra })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Action failed')
    } finally {
      setPending(false)
    }
  }

  function toggle() {
    const service = active ? 'turn_off' : 'turn_on'
    return run(domain === 'media_player' ? 'media_player' : 'homeassistant', service)
  }

  const disabled = pending || !entity

  return (
    <article
      className={`entity-tile glass ${active ? 'is-active' : ''} ${lightOn ? 'is-light-on' : ''} ${hazard ? 'is-hazard' : ''} ${config.kind === 'thermostat' ? 'is-thermostat' : ''} ${subtitle ? 'has-summary' : ''} ${offline ? 'is-unavailable' : ''}`}
    >
      {/* The whole tile is one tap/long-press target, but it cannot *be* a button: it holds real
          buttons (toggle, lock, steppers), and nested interactive controls are invalid and
          unreachable to assistive tech. So the target is a transparent layer, and the controls sit
          above it as its siblings. */}
      <button
        type="button"
        className="tile-open"
        aria-label={`Open ${config.label} details`}
        onClick={openFromTap}
        onPointerDown={startPress}
        onPointerMove={movePress}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onPointerLeave={cancelPress}
        onContextMenu={(event) => event.preventDefault()}
      />
      <div className="tile-heading">
        <span className="tile-icon"><Icon size={24} aria-hidden="true" /></span>
        <div><h3>{config.label}</h3><p>{subtitle ?? displayState(entity)}</p></div>
      </div>

      {showSparkline && <Sparkline points={sparkPoints} />}
      {config.kind === 'toggle' && (
        <button
          type="button"
          className={`toggle tile-control ${active ? 'is-on' : ''}`}
          onClick={() => void toggle()}
          disabled={disabled}
          aria-pressed={active}
          aria-label={`${config.label} ${active ? 'on' : 'off'}. Turn ${active ? 'off' : 'on'}`}
          title={`Turn ${config.label} ${active ? 'off' : 'on'}`}
        >
          <span className="toggle-track" aria-hidden="true"><span className="toggle-knob" /></span>
        </button>
      )}
      {config.kind === 'lock' && (
        <div className="action-row tile-control">
          <button type="button" className="icon-action" onClick={() => void run('lock', 'lock')} disabled={disabled} title={`Lock ${config.label}`} aria-label={`Lock ${config.label}`}><Lock size={18} aria-hidden="true" /></button>
          <button type="button" className="icon-action danger" onClick={() => void run('lock', 'unlock')} disabled={disabled} title={`Unlock ${config.label}`} aria-label={`Unlock ${config.label}`}><LockOpen size={18} aria-hidden="true" /></button>
        </div>
      )}
      {config.kind === 'thermostat' && (
        <div className="tile-control">
          <ThermostatKnob entity={entity} pending={pending} onSet={(temperature) => void run('climate', 'set_temperature', { temperature })} />
        </div>
      )}
      {config.kind === 'vacuum' && (
        <div className="action-row vacuum-actions tile-control">
          <button type="button" className="icon-action" onClick={() => void run('vacuum', 'start')} disabled={disabled} title="Start cleaning" aria-label="Start cleaning"><Play size={18} aria-hidden="true" /></button>
          <button type="button" className="icon-action" onClick={() => void run('vacuum', 'pause')} disabled={disabled} title="Pause cleaning" aria-label="Pause cleaning"><Pause size={18} aria-hidden="true" /></button>
          <button type="button" className="icon-action" onClick={() => void run('vacuum', 'return_to_base')} disabled={disabled} title="Return to dock" aria-label="Return to dock"><ChevronDown size={18} aria-hidden="true" /></button>
        </div>
      )}
      {message && <p className="tile-error" role="alert">{message}</p>}
      {pending && <span className="pending-bar" />}
    </article>
  )
}

const RANGE_COMMIT_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

interface RangeControlProps {
  label: string
  icon: ReactNode
  ariaLabel: string
  /** The entity's current value; the slider follows it whenever nobody is dragging. */
  value: number
  min: number
  max: number
  disabled: boolean
  onCommit: (value: number) => void
  children?: ReactNode
}

/**
 * A controlled slider that only calls Home Assistant once, when the finger lifts or a key is
 * released. While dragging it shows the local value; after committing it keeps showing that value
 * until the entity reports back, so the thumb does not snap to the old level and then jump again.
 * An uncontrolled `defaultValue` slider never moved when the light changed from elsewhere.
 */
function RangeControl({ label, icon, ariaLabel, value, min, max, disabled, onCommit, children }: RangeControlProps) {
  const [draft, setDraft] = useState<{ value: number; base: number } | null>(null)
  const shown = draft && draft.base === value ? draft.value : value

  function commit(next: number) {
    setDraft({ value: next, base: value })
    if (next !== value) onCommit(next)
  }

  return (
    <div className="brightness-control glass-inset">
      <div><span>{icon} {label}</span><strong>{shown}%</strong></div>
      <input
        type="range"
        min={min}
        max={max}
        value={shown}
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(event) => setDraft({ value: Number(event.currentTarget.value), base: value })}
        onPointerUp={(event) => commit(Number(event.currentTarget.value))}
        onKeyUp={(event) => { if (RANGE_COMMIT_KEYS.has(event.key)) commit(Number(event.currentTarget.value)) }}
      />
      {children}
    </div>
  )
}

function ModeButtons({ label, modes, current, disabled, format, onSelect }: {
  label: string
  modes: string[]
  current: unknown
  disabled: boolean
  format: (mode: string) => string
  onSelect: (mode: string) => void
}) {
  return (
    <div className="mode-buttons glass-inset" role="group" aria-label={label}>
      {modes.map((mode) => (
        <button type="button" key={mode} className={current === mode ? 'active' : ''} aria-pressed={current === mode} onClick={() => onSelect(mode)} disabled={disabled}>
          {format(mode)}
        </button>
      ))}
    </div>
  )
}

function EntityDetails({ config, entity, onService, onClose }: { config: TileConfig; entity?: HAEntity; onService: TileProps['onService']; onClose: () => void }) {
  const ref = useDialog<HTMLElement>({ onClose })
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const Icon = icons[config.icon] ?? Info
  const domain = config.entityId.split('.')[0]
  const attributes = entity ? Object.entries(entity.attributes).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 8) : []
  const unit = typeof entity?.attributes.unit_of_measurement === 'string' ? entity.attributes.unit_of_measurement : ''
  const hasNumericHistory = Boolean(entity && entity.state.trim() !== '' && Number.isFinite(Number(entity.state)))
  const showsNetworkHistory = isNetworkEntity(config.entityId, entity)
  const supportedColorModes = entity?.attributes.supported_color_modes
  const supportsBrightness = domain === 'light' && (
    typeof entity?.attributes.brightness === 'number'
    || (Array.isArray(supportedColorModes) && supportedColorModes.some((mode) => mode !== 'onoff'))
  )
  const brightness = Math.round(Number(entity?.attributes.brightness ?? 255) / 255 * 100)
  const volume = Math.round(Number(entity?.attributes.volume_level ?? 0) * 100)
  const fanPercentage = Number(entity?.attributes.percentage ?? 0)
  const hvacModes = Array.isArray(entity?.attributes.hvac_modes) ? entity.attributes.hvac_modes.map(String) : []
  const fanModes = Array.isArray(entity?.attributes.fan_modes) ? entity.attributes.fan_modes.map(String) : []
  const presetModes = Array.isArray(entity?.attributes.preset_modes) ? entity.attributes.preset_modes.map(String) : []
  const coverFeatures = Number(entity?.attributes.supported_features)
  const showCoverAction = (feature: number) => !Number.isFinite(coverFeatures) || coverFeatures === 0 || (coverFeatures & feature) !== 0
  const disabled = pending || !entity

  async function run(serviceDomain: string, service: string, extra: Record<string, unknown> = {}) {
    setPending(true)
    setMessage(null)
    try {
      await onService(serviceDomain, service, { entity_id: config.entityId, ...extra })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Action failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="detail-backdrop" role="presentation" onClick={onClose}>
      <section ref={ref} className="detail-sheet glass-strong" role="dialog" aria-modal="true" aria-labelledby="detail-title" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" aria-hidden="true" />
        <header>
          <span className="detail-icon"><Icon size={26} aria-hidden="true" /></span>
          <div><p>{config.entityId}</p><h2 id="detail-title">{config.label}</h2></div>
          <button type="button" className="sheet-close" data-autofocus onClick={onClose} title="Close details" aria-label="Close details"><X size={20} aria-hidden="true" /></button>
        </header>
        <div className="detail-state"><span>Current state</span><strong>{displayState(entity)}</strong></div>
        {domain === 'light' && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <div className="detail-action-grid two-column">
              <button type="button" className="detail-action primary" onClick={() => void run('light', 'turn_on')} disabled={disabled}><Lightbulb size={20} aria-hidden="true" /><span>Turn on</span></button>
              <button type="button" className="detail-action" onClick={() => void run('light', 'turn_off')} disabled={disabled}><Moon size={20} aria-hidden="true" /><span>Turn off</span></button>
            </div>
            {supportsBrightness && (
              <RangeControl
                label="Brightness"
                icon={<SunMedium size={18} aria-hidden="true" />}
                ariaLabel={`${config.label} brightness`}
                value={brightness}
                min={1}
                max={100}
                disabled={disabled}
                onCommit={(level) => void run('light', 'turn_on', { brightness_pct: level })}
              >
                <div className="brightness-presets">
                  {[25, 50, 100].map((level) => <button type="button" key={level} onClick={() => void run('light', 'turn_on', { brightness_pct: level })} disabled={disabled}>{level}%</button>)}
                </div>
              </RangeControl>
            )}
          </section>
        )}
        {domain === 'lock' && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <div className="detail-action-grid two-column">
              <button type="button" className="detail-action primary" onClick={() => void run('lock', 'lock')} disabled={disabled}><Lock size={20} aria-hidden="true" /><span>Lock</span></button>
              <button type="button" className="detail-action danger" onClick={() => void run('lock', 'unlock')} disabled={disabled}><LockOpen size={20} aria-hidden="true" /><span>Unlock</span></button>
            </div>
          </section>
        )}
        {domain === 'cover' && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <div className="detail-action-grid three-column">
              {showCoverAction(1) && <button type="button" className="detail-action primary" onClick={() => void run('cover', 'open_cover')} disabled={disabled}><ArrowUp size={20} aria-hidden="true" /><span>Open</span></button>}
              {showCoverAction(8) && <button type="button" className="detail-action" onClick={() => void run('cover', 'stop_cover')} disabled={disabled}><Square size={18} aria-hidden="true" /><span>Stop</span></button>}
              {showCoverAction(2) && <button type="button" className="detail-action" onClick={() => void run('cover', 'close_cover')} disabled={disabled}><ArrowDown size={20} aria-hidden="true" /><span>Close</span></button>}
            </div>
          </section>
        )}
        {domain === 'switch' && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <div className="detail-action-grid two-column">
              <button type="button" className="detail-action primary" onClick={() => void run('switch', 'turn_on')} disabled={disabled}><Play size={20} aria-hidden="true" /><span>Turn on</span></button>
              <button type="button" className="detail-action" onClick={() => void run('switch', 'turn_off')} disabled={disabled}><Square size={18} aria-hidden="true" /><span>Turn off</span></button>
            </div>
          </section>
        )}
        {domain === 'media_player' && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <div className="detail-action-grid media-actions">
              <button type="button" className="detail-action" onClick={() => void run(domain, 'media_previous_track')} disabled={disabled}><SkipBack size={20} aria-hidden="true" /><span>Previous</span></button>
              <button type="button" className="detail-action primary" onClick={() => void run(domain, entity?.state === 'playing' ? 'media_pause' : 'media_play')} disabled={disabled}>{entity?.state === 'playing' ? <Pause size={20} aria-hidden="true" /> : <Play size={20} aria-hidden="true" />}<span>{entity?.state === 'playing' ? 'Pause' : 'Play'}</span></button>
              <button type="button" className="detail-action" onClick={() => void run(domain, 'media_next_track')} disabled={disabled}><SkipForward size={20} aria-hidden="true" /><span>Next</span></button>
            </div>
            <RangeControl
              label="Volume"
              icon={<Volume2 size={18} aria-hidden="true" />}
              ariaLabel={`${config.label} volume`}
              value={volume}
              min={0}
              max={100}
              disabled={disabled}
              onCommit={(level) => void run(domain, 'volume_set', { volume_level: level / 100 })}
            />
          </section>
        )}
        {domain === 'climate' && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <ThermostatKnob entity={entity} pending={pending} size="large" onSet={(value) => void run('climate', 'set_temperature', { temperature: value })} />
            {fanModes.length > 0 && <ModeButtons label="Fan mode" modes={fanModes} current={entity?.attributes.fan_mode} disabled={disabled} format={(mode) => `Fan ${mode.replaceAll('_', ' ')}`} onSelect={(mode) => void run('climate', 'set_fan_mode', { fan_mode: mode })} />}
            {hvacModes.length > 0 && <ModeButtons label="HVAC mode" modes={hvacModes} current={entity?.state} disabled={disabled} format={sentenceCase} onSelect={(mode) => void run('climate', 'set_hvac_mode', { hvac_mode: mode })} />}
            {presetModes.length > 0 && <ModeButtons label="Preset mode" modes={presetModes} current={entity?.attributes.preset_mode} disabled={disabled} format={sentenceCase} onSelect={(mode) => void run('climate', 'set_preset_mode', { preset_mode: mode })} />}
          </section>
        )}
        {domain === 'fan' && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <div className="detail-action-grid two-column">
              <button type="button" className="detail-action primary" onClick={() => void run('fan', 'turn_on')} disabled={disabled}><Wind size={20} aria-hidden="true" /><span>Turn on</span></button>
              <button type="button" className="detail-action" onClick={() => void run('fan', 'turn_off')} disabled={disabled}><Square size={18} aria-hidden="true" /><span>Turn off</span></button>
            </div>
            <RangeControl
              label="Speed"
              icon={<Wind size={18} aria-hidden="true" />}
              ariaLabel={`${config.label} speed`}
              value={fanPercentage || 50}
              min={1}
              max={100}
              disabled={disabled}
              onCommit={(percentage) => void run('fan', 'set_percentage', { percentage })}
            />
          </section>
        )}
        {domain === 'vacuum' && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <div className="detail-action-grid three-column">
              <button type="button" className="detail-action primary" onClick={() => void run('vacuum', 'start')} disabled={disabled}><Play size={20} aria-hidden="true" /><span>Clean</span></button>
              <button type="button" className="detail-action" onClick={() => void run('vacuum', 'pause')} disabled={disabled}><Pause size={20} aria-hidden="true" /><span>Pause</span></button>
              <button type="button" className="detail-action" onClick={() => void run('vacuum', 'return_to_base')} disabled={disabled}><ChevronDown size={20} aria-hidden="true" /><span>Dock</span></button>
            </div>
          </section>
        )}
        {(domain === 'scene' || domain === 'script') && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <button type="button" className="detail-action primary full-width" onClick={() => void run(domain, 'turn_on')} disabled={disabled}><Send size={20} aria-hidden="true" /><span>{domain === 'scene' ? 'Activate scene' : 'Run script'}</span></button>
          </section>
        )}
        {message && <p className="detail-error" role="alert">{message}</p>}
        {pending && <div className="detail-progress" role="status">Sending command</div>}
        {showsNetworkHistory && (
          <Suspense fallback={<LoadingState label="Preparing network history" />}>
            <NetworkDetail />
          </Suspense>
        )}
        {hasNumericHistory && entity && (
          <Suspense fallback={<LoadingState label="Preparing history" />}>
            <EntityHistory entityId={entity.entity_id} unit={unit} currentState={entity.state} />
          </Suspense>
        )}
        {!showsNetworkHistory && !hasNumericHistory && entity && ['light', 'switch', 'lock', 'cover', 'binary_sensor', 'media_player', 'vacuum', 'fan', 'climate'].includes(domain) && (
          <StateTimeline entityId={entity.entity_id} currentState={entity.state} formatState={(state) => formatEntityState(entity, state)} />
        )}
        <h3 className="detail-subheading">Details</h3>
        <div className="attribute-grid">
          {attributes.length ? attributes.map(([name, value]) => <div key={name}><span>{sentenceCase(name)}</span><strong>{String(value)}</strong></div>) : <p>No additional attributes available.</p>}
        </div>
        {entity?.last_changed && <footer>Last changed {new Date(entity.last_changed).toLocaleString()}</footer>}
      </section>
    </div>
  )
}

/** Slide count per section that has slides, so a slide number read from the URL can be clamped. */
const SLIDE_COUNTS: Record<string, number> = {
  insights: insightsSlides.length,
  weather: WEATHER_SLIDE_COUNT,
  flights: flightsSlideCount,
}

function initialSlide(location: ReturnType<typeof parseShellHash>, sectionId: string) {
  return location.section === sectionId ? clampSlide(location.slide, SLIDE_COUNTS[sectionId]) : 0
}

function App() {
  // Read once: the page and slide a reload (or a bookmarked #/climate) should land on.
  const [startLocation] = useState(() => parseShellHash(window.location.hash))
  const [requestedSection, setActiveSection] = useState(() => startLocation.section ?? 'home')
  const photoIds = usePhotoLibrary()
  const [now, setNow] = useState(() => new Date())
  const [expandedTile, setExpandedTile] = useState<TileConfig | null>(null)
  const [alerts, setAlerts] = useState<StateAlert[]>([])
  // A press of the rotation button is a deliberate "hold here" and survives a reload; a touch on
  // the page only pauses rotation for a while. Kept apart so the second can never undo the first.
  const [rotationHeld, setRotationHeld] = useState(readRotationHold)
  const [interactionPaused, setInteractionPaused] = useState(false)
  const autoRotate = !rotationHeld && !interactionPaused
  const [insightsSlide, setInsightsSlide] = useState(() => initialSlide(startLocation, 'insights'))
  const [weatherSlide, setWeatherSlide] = useState(() => initialSlide(startLocation, 'weather'))
  const [flightsSlide, setFlightsSlide] = useState(() => initialSlide(startLocation, 'flights'))
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarTouchedAt, setSidebarTouchedAt] = useState(0)
  const [securityOpen, setSecurityOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [eventLogOpen, setEventLogOpen] = useState(false)
  const [connectionOpen, setConnectionOpen] = useState(false)
  const [countdown, setCountdown] = useState<{ key: string; seconds: number } | null>(null)
  const [nightModeStatus, setNightModeStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle')
  const [nightModeMessage, setNightModeMessage] = useState('Locks, garage, and indoor lighting')
  const nightConfirm = useTwoTapConfirm()
  const phoneLayout = useMediaQuery('(max-width: 760px)')
  const { events, addEvent } = useEventLog()
  const alertTimers = useRef<Map<number, number>>(new Map())
  const resumeTimer = useRef<number | undefined>(undefined)
  const handleStateChange = useCallback((change: HAStateChange) => {
    const alert = createStateAlert(change)
    if (!alert) return
    addEvent(alert)
    setAlerts((current) => [...current.filter((item) => item.id !== alert.id), alert].slice(-3))
    const timer = window.setTimeout(() => {
      setAlerts((current) => current.filter((item) => item.id !== alert.id))
      alertTimers.current.delete(alert.id)
    }, 5_000)
    alertTimers.current.set(alert.id, timer)
  }, [addEvent])
  const { entities, health, loading, error, callService, runNightMode, connection, lastMessageAt, authFailed } = useHomeAssistant(handleStateChange)
  const autoDimClass = useAutoDim(entities)

  const {
    sections: dashboardSections,
    nightModeIndoorLights,
    energyRatePerKwh,
    customized: configCustomized,
    ready: configReady,
    error: configError,
    save: saveDashboardConfig,
    saveEnergyRate,
    reset: resetDashboardConfig,
  } = useDashboardConfig()
  // An unknown id from an old URL falls back to the first section rather than a blank page.
  const section = dashboardSections.find((item) => item.id === requestedSection) ?? dashboardSections[0]
  const activeSection = section.id
  const sheetOpen = Boolean(expandedTile) || configOpen || securityOpen || eventLogOpen || connectionOpen

  // Scenes is a page of buttons to press, not something to watch go by, so the unattended rotation
  // skips it. It stays in the sidebar and in swipe order — this only affects the automatic cycle.
  const rotationSections = useMemo(
    () => dashboardSections.filter((item) => !ROTATION_EXCLUDED_SECTIONS.has(item.id)),
    [dashboardSections],
  )
  const insights = useInsights(activeSection === 'insights')

  const closeAllSheets = useCallback(() => {
    setExpandedTile(null)
    setConfigOpen(false)
    setSecurityOpen(false)
    setEventLogOpen(false)
    setConnectionOpen(false)
  }, [])
  // The tablet's Back button closes whatever sheet is open instead of leaving the dashboard.
  useBackToClose(sheetOpen, closeAllSheets)

  // Minute-aligned, so the clock turns over with the real minute instead of up to 30 s late.
  useEffect(() => {
    let interval: number | undefined
    const align = window.setTimeout(() => {
      setNow(new Date())
      interval = window.setInterval(() => setNow(new Date()), 60_000)
    }, 60_000 - (Date.now() % 60_000))
    return () => {
      window.clearTimeout(align)
      if (interval) window.clearInterval(interval)
    }
  }, [])

  // ---- URL state -------------------------------------------------------------------------------
  const urlSlide = activeSection === 'insights' ? insightsSlide : activeSection === 'weather' ? weatherSlide : activeSection === 'flights' ? flightsSlide : 0
  const hash = shellHash(activeSection, urlSlide)
  const hashRef = useRef(hash)
  // replaceState, never pushState: every rotation tick changes this, and Back must not have to
  // step through a hundred rotated pages to leave. Only an open sheet adds a history entry.
  useEffect(() => {
    hashRef.current = hash
    if (window.location.hash !== hash) window.history.replaceState(window.history.state, '', hash)
  }, [hash])
  useEffect(() => {
    // Popping a sheet's history entry lands on the entry beneath it, whose hash is whatever the
    // page was when the sheet opened. Put the current page back.
    function resync() {
      if (window.location.hash !== hashRef.current) window.history.replaceState(window.history.state, '', hashRef.current)
    }
    window.addEventListener('popstate', resync)
    return () => window.removeEventListener('popstate', resync)
  }, [])
  useEffect(() => {
    document.title = `${section.label} · Home Panel`
  }, [section.label])

  // ---- Rotation --------------------------------------------------------------------------------
  const rotating = autoRotate && !sheetOpen
  const rotationDelay = activeSection === 'weather' || activeSection === 'flights' ? SLIDE_INTERVAL_MS : rotationInterval
  const rotationKey = `${activeSection}:${insightsSlide}:${weatherSlide}:${flightsSlide}`
  const secondsLeft = countdown?.key === rotationKey ? countdown.seconds : Math.round(rotationDelay / 1000)

  // Insights advances through its own panels first, so it holds for slides x interval before the next section.
  useEffect(() => {
    // Any open sheet also blocks rotation: now that a pause expires on its own, the page could
    // otherwise slide out from behind whatever the user still has open.
    if (!rotating) return
    const deadline = Date.now() + rotationDelay
    // The countdown in the rotation chip. Keyed to this page/slide so a stale tick from the
    // previous one can never be shown against the new page.
    const tick = window.setInterval(() => {
      setCountdown({ key: rotationKey, seconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) })
    }, 1_000)
    const timer = window.setTimeout(() => {
      if (activeSection === 'insights' && insightsSlide < insightsSlides.length - 1) {
        setInsightsSlide(insightsSlide + 1)
        return
      }
      if (activeSection === 'weather' && weatherSlide < WEATHER_SLIDE_COUNT - 1) {
        setWeatherSlide(weatherSlide + 1)
        return
      }
      if (activeSection === 'flights' && flightsSlide < flightsSlideCount - 1) {
        setFlightsSlide(flightsSlide + 1)
        return
      }
      if (rotationSections.length === 0) return
      setInsightsSlide(0)
      setWeatherSlide(0)
      setFlightsSlide(0)
      // A section that rotation skips is not in this list, so `findIndex` returns -1 and the +1
      // lands on the first rotating section -- which is what should happen when the cycle resumes
      // from a page it does not itself visit.
      const currentIndex = rotationSections.findIndex((item) => item.id === activeSection)
      setActiveSection(rotationSections[(currentIndex + 1) % rotationSections.length].id)
    }, rotationDelay)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(tick)
    }
  }, [rotating, rotationDelay, rotationKey, activeSection, insightsSlide, weatherSlide, flightsSlide, rotationSections])

  useEffect(() => () => {
    alertTimers.current.forEach((timer) => window.clearTimeout(timer))
    if (resumeTimer.current) window.clearTimeout(resumeTimer.current)
  }, [])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  // The sidebar hides itself so the wall panel stays clean, but only while it is being ignored:
  // every touch inside it bumps `sidebarTouchedAt`, which restarts the countdown.
  useEffect(() => {
    if (!sidebarOpen) return
    const timer = window.setTimeout(() => setSidebarOpen(false), SIDEBAR_IDLE_MS)
    return () => window.clearTimeout(timer)
  }, [sidebarOpen, sidebarTouchedAt])

  const swipeStart = useRef<{ x: number; y: number } | null>(null)

  /**
   * Interaction pauses rotation so the page being used does not slide away mid-tap. A wall panel
   * must not then sit on that page forever because somebody brushed it walking past, so the pause
   * expires on its own and rotation resumes. Pressing the rotation button is treated differently
   * on purpose: that is a deliberate "hold here", and it sticks until pressed again.
   */
  function stopRotation() {
    setInteractionPaused(true)
    if (resumeTimer.current) window.clearTimeout(resumeTimer.current)
    resumeTimer.current = window.setTimeout(() => {
      resumeTimer.current = undefined
      setInteractionPaused(false)
    }, AUTO_RESUME_MS)
  }

  function toggleRotation() {
    if (resumeTimer.current) {
      window.clearTimeout(resumeTimer.current)
      resumeTimer.current = undefined
    }
    if (autoRotate) {
      setRotationHeld(true)
      writeRotationHold(true)
    } else {
      setRotationHeld(false)
      setInteractionPaused(false)
      writeRotationHold(false)
    }
  }

  /** Restarts the sidebar's hide countdown, rate-limited so pointer-move does not churn state. */
  function keepSidebarOpen() {
    setSidebarTouchedAt((current) => (Date.now() - current > 800 ? Date.now() : current))
  }

  // Touch-first navigation: horizontal swipes on the page move between sections.
  function handleSwipeStart(event: React.TouchEvent) {
    const target = event.target as Element
    swipeStart.current = target.closest(SWIPE_IGNORE) ? null : { x: event.touches[0].clientX, y: event.touches[0].clientY }
  }

  function handleSwipeEnd(event: React.TouchEvent) {
    if (!swipeStart.current) return
    const deltaX = event.changedTouches[0].clientX - swipeStart.current.x
    const deltaY = event.changedTouches[0].clientY - swipeStart.current.y
    swipeStart.current = null
    if (Math.abs(deltaX) < 72 || Math.abs(deltaY) > 56) return
    const currentIndex = dashboardSections.findIndex((item) => item.id === activeSection)
    const nextIndex = (currentIndex + (deltaX < 0 ? 1 : -1) + dashboardSections.length) % dashboardSections.length
    selectSection(dashboardSections[nextIndex].id)
  }

  function selectSection(sectionId: string) {
    stopRotation()
    setActiveSection(sectionId)
    setSidebarOpen(false)
    if (sectionId !== activeSection) {
      setInsightsSlide(0)
      setWeatherSlide(0)
      setFlightsSlide(0)
    }
  }

  function selectInsightsSlide(index: number) {
    stopRotation()
    setInsightsSlide(index)
  }

  function selectWeatherSlide(index: number) {
    stopRotation()
    setWeatherSlide(index)
  }

  function selectFlightsSlide(index: number) {
    stopRotation()
    setFlightsSlide(index)
  }

  /** Jump straight to one Flights slide from elsewhere, e.g. tapping the header's flight banner. */
  function openFlightsSlide(index: number) {
    stopRotation()
    setSidebarOpen(false)
    setActiveSection('flights')
    setFlightsSlide(index)
  }

  function expandTile(tile: TileConfig) {
    stopRotation()
    setExpandedTile(tile)
  }

  /** The energy rate is part of the saved layout; saving it before that has loaded would write
   *  the factory layout back over the household's own. */
  const saveRateWhenReady = useCallback(
    (rate: number) => (configReady
      ? saveEnergyRate(rate)
      : Promise.reject(new Error('Saved settings are still loading, so the rate cannot be saved yet. Try again in a moment.'))),
    [configReady, saveEnergyRate],
  )

  async function activateNightMode() {
    // Two taps rather than window.confirm, which kiosk WebViews can suppress outright -- making
    // Night Mode silently impossible to trigger.
    if (!nightConfirm.request()) return

    setNightModeStatus('pending')
    setNightModeMessage('Securing the home…')
    try {
      const result = await runNightMode()
      const actionCount = result.locked.length + result.garagesClosed.length + result.lightsTurnedOff.length + result.switchesTurnedOff.length
      if (result.failures.length) {
        setNightModeStatus('error')
        setNightModeMessage(`${actionCount} completed · ${result.failures.length} failed`)
      } else {
        setNightModeStatus('success')
        setNightModeMessage(actionCount ? `${actionCount} actions completed` : 'Home was already secured')
      }
    } catch (actionError) {
      setNightModeStatus('error')
      setNightModeMessage(actionError instanceof Error ? actionError.message : 'Night Mode failed')
    }
  }

  const sidebarHidden = !sidebarOpen && !phoneLayout
  const clockLabel = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const thermostat = entities.get('climate.mainfoor_thermostat')
  const minutesSinceData = lastMessageAt === null ? null : Math.max(0, Math.floor((now.getTime() - lastMessageAt) / 60_000))
  const showConfigHint = health !== null && health.home_assistant.configured === false
  const showError = Boolean(error) && !loading && !authFailed && connection !== 'stale'
  const rotationLabel = !autoRotate ? 'Paused' : sheetOpen ? 'Held' : `${secondsLeft}s`
  const rotationTitle = !autoRotate
    ? 'Resume automatic page rotation'
    : `Pause automatic page rotation · next ${activeSection in SLIDE_COUNTS ? 'slide' : 'page'} in ${secondsLeft}s`
  const SectionIcon = sectionIcons[activeSection] ?? Square

  const lazyView = (label: string, view: ReactNode) => <Suspense fallback={<LoadingState label={label} />}>{view}</Suspense>

  return (
    <div className={`command-center ${autoDimClass}`.trim()}>
      <div className="alert-stack" aria-live="polite" aria-atomic="false" data-swipe-ignore>
        {alerts.map((alert) => (
          <button type="button" key={alert.id} className={`state-alert glass-strong ${alert.tone}`} onClick={() => setAlerts((current) => current.filter((item) => item.id !== alert.id))}>
            <span aria-hidden="true">{alert.tone === 'critical' ? <AlertTriangle size={22} /> : <BellRing size={22} />}</span>
            <div><strong>{alert.title}</strong><p>{alert.message}</p></div>
            <X size={17} aria-hidden="true" />
          </button>
        ))}
      </div>
      {sidebarOpen && <button type="button" className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
      <aside
        className={`sidebar glass-strong ${sidebarOpen ? 'is-open' : ''}`}
        // Hidden and inert only as the slide-in drawer; on a phone it is the always-visible tab bar.
        aria-hidden={sidebarHidden || undefined}
        inert={sidebarHidden}
        data-dialog-background
        onPointerDown={keepSidebarOpen}
        onPointerMove={keepSidebarOpen}
        onFocusCapture={keepSidebarOpen}
      >
        <div className="brand" title="Home Panel"><span className="brand-mark"><Wind size={22} aria-hidden="true" /></span><span>Home Panel</span></div>
        <nav aria-label="Dashboard sections">
          {dashboardSections.map((item) => {
            const NavIcon = sectionIcons[item.id] ?? Square
            return (
              <button type="button" key={item.id} className={item.id === activeSection ? 'active' : ''} aria-current={item.id === activeSection ? 'page' : undefined} onClick={() => selectSection(item.id)}>
                <NavIcon size={20} aria-hidden="true" /><span>{item.label}</span>
              </button>
            )
          })}
        </nav>
        <button
          type="button"
          className="settings-button"
          onClick={() => { stopRotation(); setSidebarOpen(false); setConfigOpen(true) }}
          disabled={!configReady}
          title={configReady ? 'Customize dashboard tiles and Night Mode lights' : configError ? `Saved layout could not be loaded: ${configError}` : 'Waiting for saved layout…'}
        >
          <Wrench size={20} aria-hidden="true" /><span>{configReady ? `Configure${configCustomized ? '' : ' (default)'}` : 'Configure · loading'}</span>
        </button>
      </aside>

      <main
        className={`${activeSection === 'weather' || activeSection === 'flights' ? 'is-fixed-view' : ''}${activeSection === 'insights' ? 'is-tall-view' : ''}`.trim() || undefined}
        data-dialog-background
        onTouchStart={handleSwipeStart}
        onTouchEnd={handleSwipeEnd}
        onPointerDownCapture={(event) => {
          if (!(event.target as Element).closest('.rotation-status')) stopRotation()
        }}
      >
        {/* Behind everything in main, on the few pages quiet enough to carry one. */}
        <PhotoBackdrop sectionId={activeSection} photoIds={photoIds} />
        <header className="topbar glass">
          <div className="page-title">
            <button
              type="button"
              className="nav-toggle"
              onClick={() => setSidebarOpen((open) => !open)}
              aria-expanded={sidebarOpen}
              aria-label={sidebarOpen ? 'Hide navigation' : 'Show navigation'}
              title={sidebarOpen ? 'Hide navigation' : 'Show navigation'}
            >
              {sidebarOpen ? <PanelLeftClose size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
            </button>
            <div><p className="date">{now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</p><h1>{section.label}</h1></div>
          </div>
          <TrackedAircraftBadge entities={entities} onOpenFlights={openFlightsSlide} />
          <div className="clock-block">
            {/* Mirrors the flight banner: a live value in the header that opens the page it
                summarises. The clock is the local time; World time is every other one. */}
            <button
              type="button"
              className="clock-time"
              onClick={() => selectSection('world')}
              title="Open World time"
              aria-label={`${clockLabel} — open World time`}
            >
              {clockLabel}
            </button>
            <div className="topbar-utilities">
              <ConnectionStatus
                health={health}
                entities={entities}
                connection={connection}
                open={connectionOpen}
                onOpenChange={(open) => { if (open) stopRotation(); setConnectionOpen(open) }}
              />
              <button type="button" className="topbar-chip" onClick={() => { stopRotation(); setEventLogOpen(true) }} title="View activity log" aria-label="View activity log"><History size={18} aria-hidden="true" /></button>
              <button
                type="button"
                className={`topbar-chip rotation-status ${autoRotate ? 'is-running' : 'is-paused'}`}
                onClick={(event) => { event.stopPropagation(); toggleRotation() }}
                title={rotationTitle}
                aria-label={rotationTitle}
                aria-pressed={!autoRotate}
              >
                {autoRotate ? <RotateCw size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
                <span aria-hidden="true">{rotationLabel}</span>
              </button>
            </div>
          </div>
        </header>

        {(authFailed || connection === 'stale' || connection === 'reconnecting' || showConfigHint || showError) && (
          <div className="shell-banners">
            {authFailed && (
              <div className="status-banner glass-strong tone-danger" role="alert">
                <KeyRound size={20} aria-hidden="true" />
                <span>Home Assistant rejected the backend&apos;s token. Check the add-on configuration.</span>
              </div>
            )}
            {!authFailed && connection === 'stale' && (
              <div className="status-banner glass-strong tone-warn" role="status">
                <WifiOff size={20} aria-hidden="true" />
                <span>
                  Live data paused, showing last known state
                  {minutesSinceData !== null && ` · updated ${minutesSinceData < 1 ? 'just now' : `${minutesSinceData} min ago`}`}
                </span>
              </div>
            )}
            {connection === 'reconnecting' && (
              <div className="reconnecting-pill glass-pill" role="status"><RotateCw size={15} className="spin" aria-hidden="true" /><span>Reconnecting…</span></div>
            )}
            {showConfigHint && (
              <div className="status-banner glass-strong tone-warn" role="status"><Shield size={20} aria-hidden="true" /><span>Add HA_URL and HA_TOKEN to the Python backend to load live devices.</span></div>
            )}
            {showError && (
              <div className="status-banner glass-strong tone-warn" role="status"><AlertTriangle size={20} aria-hidden="true" /><span>{error}</span></div>
            )}
          </div>
        )}

        {activeSection === 'home' && (
          <>
            <section className="moments-strip" aria-label="Home moments">
              <button
                type="button"
                className={`night-mode-moment glass is-${nightModeStatus} ${nightConfirm.armed ? 'is-armed' : ''}`}
                onClick={() => void activateNightMode()}
                disabled={nightModeStatus === 'pending' || !health?.home_assistant.connected}
                aria-describedby="night-mode-detail"
              >
                <span className="moment-icon"><Moon size={21} aria-hidden="true" /></span>
                <span className="moment-copy">
                  <strong>{nightConfirm.armed ? 'Tap again to confirm' : 'Night Mode'}</strong>
                  <small id="night-mode-detail">
                    {nightConfirm.armed
                      ? 'Locks every lock, closes the garage, turns off indoor lights'
                      // Disabled is said in words, not by fading the button.
                      : !health?.home_assistant.connected && nightModeStatus !== 'pending' ? 'Unavailable until Home Assistant connects' : nightModeMessage}
                  </small>
                </span>
                <Lock size={17} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="thermostat-quick glass"
                onClick={() => selectSection('climate')}
                aria-label="Open thermostat"
              >
                <span className="moment-icon thermo-accent"><Thermometer size={20} aria-hidden="true" /></span>
                <span className="moment-copy">
                  <strong>{thermostat ? `${Math.round(Number(thermostat.attributes.temperature ?? 70))}°` : '--°'}</strong>
                  <small>{thermostat ? `Now ${Math.round(Number(thermostat.attributes.current_temperature ?? 0))}° · ${sentenceCase(String(thermostat.attributes.hvac_action ?? thermostat.state ?? 'idle'))}` : 'Thermostat'}</small>
                </span>
              </button>
            </section>
            <UtilityRail entities={entities} activeSection={activeSection} autoRotate={autoRotate} onSelect={selectSection} onInspectSecurity={() => { stopRotation(); setSecurityOpen(true) }} now={now} />
          </>
        )}

        <div className="page-slide" key={activeSection}>
        {activeSection === 'insights' ? (
          lazyView('Preparing insights', <InsightsView entities={entities} series={insights.series} loading={insights.loading} slide={insightsSlide} onSelectSlide={selectInsightsSlide} />)
        ) : activeSection === 'world' ? (
          <WorldTimeMap now={now} />
        ) : activeSection === 'weather' ? (
          <WeatherView entities={entities} slide={weatherSlide} onSelectSlide={selectWeatherSlide} />
        ) : activeSection === 'flights' ? (
          lazyView('Preparing flights', <FlightsView entities={entities} slide={flightsSlide} onSelectSlide={selectFlightsSlide} />)
        ) : activeSection === 'health' ? (
          lazyView('Checking home health', <HealthView onExpand={expandTile} />)
        ) : activeSection === 'maintenance' ? (
          lazyView('Checking maintenance', <MaintenanceView onExpand={expandTile} onService={callService} />)
        ) : activeSection === 'photos' ? (
          lazyView('Loading photos', <PhotosView />)
        ) : activeSection === 'network' ? (
          lazyView('Preparing network', <NetworkView entities={entities} onService={callService} onExpand={expandTile} />)
        ) : activeSection === 'roborock' ? (
          lazyView('Preparing Roborock', <RoborockView entities={entities} onService={callService} onExpand={expandTile} />)
        ) : activeSection === 'energy' ? (
          lazyView('Preparing energy usage', <EnergyView entities={entities} ratePerKwh={energyRatePerKwh} onSaveRate={saveRateWhenReady} />)
        ) : activeSection === 'volvo' ? (
          lazyView('Preparing Volvo', <VolvoView entities={entities} onExpand={expandTile} />)
        ) : (
          <PageFrame
            className="overview has-pane"
            eyebrow="My home"
            title={section.label}
            icon={<SectionIcon />}
            meta={loading ? 'Loading entities…' : `${section.tiles.filter((tile) => entities.has(tile.entityId)).length} available`}
            actions={activeSection === 'home' ? <PresenceRow entities={entities} /> : undefined}
          >
            {activeSection === 'climate' && thermostat && (
              <div className="climate-hero glass">
                <ThermostatKnob entity={thermostat} pending={false} size="large" onSet={(value) => void callService('climate', 'set_temperature', { entity_id: 'climate.mainfoor_thermostat', temperature: value })} />
              </div>
            )}
            <div className="entity-grid">
              {section.tiles.filter((tile) => !(activeSection === 'climate' && tile.entityId === 'climate.mainfoor_thermostat')).map((tile) => {
                const isDoorCount = tile.entityId === 'sensor.doors_open_count'
                return (
                  <EntityTile
                    key={tile.entityId}
                    config={tile}
                    entity={entities.get(tile.entityId)}
                    onService={callService}
                    onExpand={() => expandTile(tile)}
                    subtitle={isDoorCount ? openDoorSummary(entities) : undefined}
                    noSparkline={isDoorCount}
                  />
                )
              })}
            </div>
          </PageFrame>
        )}
        </div>
      </main>
      {securityOpen && (
        <SecurityPanel
          entities={entities}
          onInspect={(tile) => { setSecurityOpen(false); setExpandedTile(tile) }}
          onOpenSection={() => { setSecurityOpen(false); selectSection('security') }}
          onClose={() => setSecurityOpen(false)}
          now={now}
        />
      )}
      {expandedTile && <EntityDetails config={expandedTile} entity={entities.get(expandedTile.entityId)} onService={callService} onClose={() => setExpandedTile(null)} />}
      {configOpen && (
        <ConfigPanel
          entities={entities}
          sections={dashboardSections}
          nightModeIndoorLights={nightModeIndoorLights}
          onSave={saveDashboardConfig}
          onReset={resetDashboardConfig}
          onClose={() => setConfigOpen(false)}
          ready={configReady}
          loadError={configError}
        />
      )}
      {eventLogOpen && <EventLog events={events} onClose={() => setEventLogOpen(false)} />}
    </div>
  )
}

export default App
