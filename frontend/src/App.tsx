import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, Battery, BellRing, Bot, ChartNoAxesCombined,
  ArrowDown, ArrowUp, ChevronDown, CloudSun, History, Lightbulb,
  Info, Lock, LockOpen, Menu, MonitorSmartphone, Moon, PanelLeftClose, Pause, Play,
  RotateCw, Send,
  Shield, SkipBack, SkipForward, Square, SunMedium, Thermometer, Volume2,
  Wifi, Wind, Wrench, X,
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

const InsightsView = lazy(() => import('./InsightsView').then((module) => ({ default: module.InsightsView })))
const EntityHistory = lazy(() => import('./EntityHistory').then((module) => ({ default: module.EntityHistory })))
const EnergyView = lazy(() => import('./EnergyView').then((module) => ({ default: module.EnergyView })))
const VolvoView = lazy(() => import('./VolvoView').then((module) => ({ default: module.VolvoView })))
const FlightsView = lazy(() => import('./FlightsView').then((module) => ({ default: module.FlightsView })))
const NetworkDetail = lazy(() => import('./NetworkDetail').then((module) => ({ default: module.NetworkDetail })))

/** The WAN sensor is a plain on/off, so its detail sheet gets the router's throughput story instead. */
function isNetworkEntity(entityId: string, entity: HAEntity | undefined) {
  return entityId === 'binary_sensor.cbr750_gateway_wan_status'
    || (String(entity?.attributes.device_class ?? '') === 'connectivity' && /wan|internet|gateway/i.test(entityId))
}

function formatEntityState(entity: HAEntity, state: string) {
  const domain = entity.entity_id.split('.')[0]
  const deviceClass = String(entity.attributes.device_class ?? '')
  if (domain === 'binary_sensor') {
    if (['door', 'garage_door', 'window', 'opening'].includes(deviceClass)) return state === 'on' ? 'open' : state === 'off' ? 'closed' : state
    if (deviceClass === 'moisture') return state === 'on' ? 'leak detected' : state === 'off' ? 'dry' : state
    if (deviceClass === 'motion' || deviceClass === 'occupancy') return state === 'on' ? 'detected' : state === 'off' ? 'clear' : state
    if (['smoke', 'gas', 'problem', 'safety'].includes(deviceClass)) return state === 'on' ? 'detected' : state === 'off' ? 'clear' : state
  }
  return state.replaceAll('_', ' ')
}

function displayState(entity: HAEntity | undefined) {
  if (!entity) return 'Unavailable'
  const numericValue = Number(entity.state)
  const unit = typeof entity.attributes.unit_of_measurement === 'string'
    ? entity.attributes.unit_of_measurement
    : ''
  if (Number.isFinite(numericValue)) {
    if (unit === 'KiB/s') return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(numericValue * 8 / 1024)} Mbps`
    const digits = unit === '%' ? 0 : 1
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(numericValue)}${unit ? ` ${unit}` : ''}`
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
  const names = open.map((entity) => String(entity.attributes.friendly_name ?? entity.entity_id.split('.')[1].replaceAll('_', ' ')))
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

const discreteDomains = new Set(['light', 'switch', 'lock', 'cover', 'media_player', 'vacuum'])
const alertingBinaryClasses = new Set(['door', 'garage_door', 'window', 'opening', 'moisture', 'smoke', 'gas', 'problem', 'safety'])

function createStateAlert(change: HAStateChange): StateAlert | null {
  const { entity, previousState } = change
  const domain = entity.entity_id.split('.')[0]
  const deviceClass = String(entity.attributes.device_class ?? '')
  if (!discreteDomains.has(domain) && !(domain === 'binary_sensor' && alertingBinaryClasses.has(deviceClass))) return null

  const title = String(entity.attributes.friendly_name ?? entity.entity_id.split('.')[1].replaceAll('_', ' '))
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
  const friendlyName = (entity: HAEntity) => String(entity.attributes.friendly_name ?? entity.entity_id.split('.')[1].replaceAll('_', ' '))
  const numericState = (entity: HAEntity) => Number(entity.state)
  const outside = entities.get('sensor.open_weather_temperature') ?? all.find((entity) => deviceClass(entity) === 'temperature' && friendlyName(entity).toLowerCase().includes('outside'))
  const humidity = entities.get('sensor.open_weather_humidity') ?? all.find((entity) => deviceClass(entity) === 'humidity' && friendlyName(entity).toLowerCase().includes('outside'))
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
  const networkEntity = entities.get('binary_sensor.cbr750_gateway_wan_status') ?? all.find((entity) => deviceClass(entity) === 'connectivity' && friendlyName(entity).toLowerCase().includes('wan'))
  const downloadEntity = entities.get('sensor.cbr750_gateway_download_speed') ?? all.find((entity) => friendlyName(entity).toLowerCase().includes('download speed'))
  const batteryEntity = entities.get('sensor.dashboard_battery_level') ?? all.find((entity) => deviceClass(entity) === 'battery' && /(dashboard|tablet)/i.test(friendlyName(entity)))
  const vacuum = entities.get('vacuum.roborock_qrevo_maxv') ?? all.find((entity) => entity.entity_id.startsWith('vacuum.'))
  const lowBatteries = all
    .filter((entity) => deviceClass(entity) === 'battery' && Number.isFinite(numericState(entity)) && numericState(entity) <= 20)
    .sort((left, right) => numericState(left) - numericState(right))
  const activeProblems = all.filter((entity) => entity.entity_id.startsWith('binary_sensor.') && deviceClass(entity) === 'problem' && entity.state === 'on')
  const plants = all.filter((entity) => {
    const searchable = `${entity.entity_id} ${friendlyName(entity)} ${deviceClass(entity)}`.toLowerCase()
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
  const weatherState = String(weather?.state ?? '').replaceAll('_', ' ').replace('partlycloudy', 'partly cloudy')
  const condition = weatherState ? weatherState.replace(/^./, (letter) => letter.toUpperCase()) : 'Weather'
  // Rail copy stays terse on purpose: six cells share one row at wall-panel type sizes, so a longer
  // phrase would just be truncated to an ellipsis and read as nothing at all.
  const securityDetail = unsafeLocks.length
    ? unsafeLocks.map(friendlyName).slice(0, 1).join(' · ')
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
    activeProblems.length ? friendlyName(activeProblems[0]) : '',
    lowBatteries.length ? `${friendlyName(lowBatteries[0])} ${displayState(lowBatteries[0])}` : '',
    dryPlants.length ? `${friendlyName(dryPlants[0])} ${displayState(dryPlants[0])}` : '',
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
        ? `New: ${friendlyName(newDevice)}`
        : trackers.length ? `${awayDevices.length} away · ${trackers.length} tracked` : 'No device trackers',
      tone: newDevice ? 'warn' : 'accent',
    },
    { id: 'security', target: 'security', icon: Shield, title: securityIssues > 0 ? `${securityIssues} security alert${securityIssues === 1 ? '' : 's'}` : securityKnown ? 'Secure' : 'Security', detail: securityDetail, tone: securityIssues > 0 ? 'danger' : securityKnown ? 'good' : 'muted', inspect: true },
    { id: 'weather', target: 'weather', icon: CloudSun, title: outside ? `${displayState(outside)} · ${condition}` : condition, detail: weatherDetail || 'Waiting for weather', tone: 'weather' },
    { id: 'network', target: 'insights', icon: Wifi, title: networkOnline ? 'WAN online' : networkEntity ? 'WAN offline' : 'Network', detail: downloadEntity ? `${displayState(downloadEntity)} down` : 'Checking connection', tone: networkOnline ? 'good' : networkEntity ? 'danger' : 'muted' },
    { id: 'tablet', target: batteryEntity ? 'home' : 'roborock', icon: batteryEntity ? Battery : Bot, title: finalUtilityTitle, detail: finalUtilityDetail, tone: 'accent' },
  ]

  return (
    <div className="utility-stack">
      <section className="utility-rail" aria-label="Home utility status">
        {utilities.map(({ id, target, icon: Icon, title, detail, tone, inspect }) => (
          <button key={id} className={`utility-cell tone-${tone} ${id === activeSection ? 'is-current' : ''}`} onClick={() => inspect ? onInspectSecurity() : onSelect(target)}>
            <span className="utility-icon"><Icon size={19} aria-hidden="true" /></span>
            <span className="utility-copy"><strong>{title}</strong><small key={detail}>{detail}</small></span>
          </button>
        ))}
      </section>
      <button className={`attention-strip ${issueCount > 0 ? 'has-issues' : 'is-clear'}`} onClick={() => securityIssues > 0 ? onInspectSecurity() : onSelect(attentionTarget)}>
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

function EntityTile({ config, entity, onService, onExpand, subtitle, noSparkline }: TileProps) {
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const Icon = icons[config.icon] ?? Square
  const active = isActive(entity)
  const domain = config.entityId.split('.')[0]
  const lightOn = domain === 'light' && entity?.state === 'on'
  const hazard = isHazard(entity)
  // An entity that reports `unavailable` reads the same as a missing one, so it gets the same dimmed treatment.
  const offline = !entity || ['unavailable', 'unknown'].includes(entity.state)
  const showSparkline = !noSparkline && config.kind === 'sensor' && Boolean(entity) && Number.isFinite(Number(entity?.state))
  const sparkPoints = useSparkline(config.entityId, showSparkline)
  const longPressTimer = useRef<number | undefined>(undefined)
  const longPressTriggered = useRef(false)

  function startPress() {
    longPressTriggered.current = false
    longPressTimer.current = window.setTimeout(() => {
      longPressTriggered.current = true
      onExpand()
    }, 550)
  }

  function endPress() {
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current)
  }

  function openFromTap() {
    if (!longPressTriggered.current) onExpand()
    longPressTriggered.current = false
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

  return (
    <article
      className={`entity-tile ${active ? 'is-active' : ''} ${lightOn ? 'is-light-on' : ''} ${hazard ? 'is-hazard' : ''} ${config.kind === 'thermostat' ? 'is-thermostat' : ''} ${subtitle ? 'has-summary' : ''} ${offline ? 'is-unavailable' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`Open ${config.label} details`}
      onClick={openFromTap}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onExpand() }}
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onPointerLeave={endPress}
    >
      <div className="tile-heading">
        <span className="tile-icon"><Icon size={24} aria-hidden="true" /></span>
        <div><h3>{config.label}</h3><p>{subtitle ?? displayState(entity)}</p></div>
      </div>

      {showSparkline && <Sparkline points={sparkPoints} />}
      {config.kind === 'toggle' && (
        <button className={`toggle ${active ? 'is-on' : ''}`} onClick={(event) => { event.stopPropagation(); void toggle() }} onPointerDown={(event) => event.stopPropagation()} disabled={pending || !entity} title={`Turn ${config.label} ${active ? 'off' : 'on'}`}><span /></button>
      )}
      {config.kind === 'lock' && (
        <div className="action-row">
          <button className="icon-action" onClick={(event) => { event.stopPropagation(); void run('lock', 'lock') }} onPointerDown={(event) => event.stopPropagation()} disabled={pending || !entity} title={`Lock ${config.label}`}><Lock size={18} /></button>
          <button className="icon-action danger" onClick={(event) => { event.stopPropagation(); void run('lock', 'unlock') }} onPointerDown={(event) => event.stopPropagation()} disabled={pending || !entity} title={`Unlock ${config.label}`}><LockOpen size={18} /></button>
        </div>
      )}
      {config.kind === 'thermostat' && (
        <ThermostatKnob entity={entity} pending={pending} onSet={(temperature) => void run('climate', 'set_temperature', { temperature })} />
      )}
      {config.kind === 'vacuum' && (
        <div className="action-row vacuum-actions">
          <button className="icon-action" onClick={(event) => { event.stopPropagation(); void run('vacuum', 'start') }} onPointerDown={(event) => event.stopPropagation()} disabled={pending || !entity} title="Start cleaning"><Play size={18} /></button>
          <button className="icon-action" onClick={(event) => { event.stopPropagation(); void run('vacuum', 'pause') }} onPointerDown={(event) => event.stopPropagation()} disabled={pending || !entity} title="Pause cleaning"><Pause size={18} /></button>
          <button className="icon-action" onClick={(event) => { event.stopPropagation(); void run('vacuum', 'return_to_base') }} onPointerDown={(event) => event.stopPropagation()} disabled={pending || !entity} title="Return to dock"><ChevronDown size={18} /></button>
        </div>
      )}
      {message && <p className="tile-error" role="alert">{message}</p>}
      {pending && <span className="pending-bar" />}
    </article>
  )
}

function EntityDetails({ config, entity, onService, onClose }: { config: TileConfig; entity?: HAEntity; onService: TileProps['onService']; onClose: () => void }) {
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const Icon = icons[config.icon] ?? Info
  const domain = config.entityId.split('.')[0]
  const attributes = entity ? Object.entries(entity.attributes).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 8) : []
  const unit = typeof entity?.attributes.unit_of_measurement === 'string' ? entity.attributes.unit_of_measurement : ''
  const hasNumericHistory = Boolean(entity && Number.isFinite(Number(entity.state)))
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
      <section className="detail-sheet" role="dialog" aria-modal="true" aria-labelledby="detail-title" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <header><span className="detail-icon"><Icon size={26} /></span><div><p>{config.entityId}</p><h2 id="detail-title">{config.label}</h2></div><button onClick={onClose} title="Close details"><X size={20} /></button></header>
        <div className="detail-state"><span>Current state</span><strong>{displayState(entity)}</strong></div>
        {domain === 'light' && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <div className="detail-action-grid two-column">
              <button className="detail-action primary" onClick={() => void run('light', 'turn_on')} disabled={pending || !entity}><Lightbulb size={20} /><span>Turn on</span></button>
              <button className="detail-action" onClick={() => void run('light', 'turn_off')} disabled={pending || !entity}><Moon size={20} /><span>Turn off</span></button>
            </div>
            {supportsBrightness && (
              <div className="brightness-control">
                <div><span><SunMedium size={18} /> Brightness</span><strong>{brightness}%</strong></div>
                <input
                  type="range"
                  min="1"
                  max="100"
                  defaultValue={brightness}
                  aria-label={`${config.label} brightness`}
                  disabled={pending || !entity}
                  onPointerUp={(event) => void run('light', 'turn_on', { brightness_pct: Number(event.currentTarget.value) })}
                  onKeyUp={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) void run('light', 'turn_on', { brightness_pct: Number(event.currentTarget.value) }) }}
                />
                <div className="brightness-presets">
                  {[25, 50, 100].map((level) => <button key={level} onClick={() => void run('light', 'turn_on', { brightness_pct: level })} disabled={pending || !entity}>{level}%</button>)}
                </div>
              </div>
            )}
          </section>
        )}
        {domain === 'lock' && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <div className="detail-action-grid two-column">
              <button className="detail-action primary" onClick={() => void run('lock', 'lock')} disabled={pending || !entity}><Lock size={20} /><span>Lock</span></button>
              <button className="detail-action danger" onClick={() => void run('lock', 'unlock')} disabled={pending || !entity}><LockOpen size={20} /><span>Unlock</span></button>
            </div>
          </section>
        )}
        {domain === 'cover' && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <div className="detail-action-grid three-column">
              {showCoverAction(1) && <button className="detail-action primary" onClick={() => void run('cover', 'open_cover')} disabled={pending || !entity}><ArrowUp size={20} /><span>Open</span></button>}
              {showCoverAction(8) && <button className="detail-action" onClick={() => void run('cover', 'stop_cover')} disabled={pending || !entity}><Square size={18} /><span>Stop</span></button>}
              {showCoverAction(2) && <button className="detail-action" onClick={() => void run('cover', 'close_cover')} disabled={pending || !entity}><ArrowDown size={20} /><span>Close</span></button>}
            </div>
          </section>
        )}
        {domain === 'switch' && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <div className="detail-action-grid two-column">
              <button className="detail-action primary" onClick={() => void run('switch', 'turn_on')} disabled={pending || !entity}><Play size={20} /><span>Turn on</span></button>
              <button className="detail-action" onClick={() => void run('switch', 'turn_off')} disabled={pending || !entity}><Square size={18} /><span>Turn off</span></button>
            </div>
          </section>
        )}
        {domain === 'media_player' && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <div className="detail-action-grid media-actions">
              <button className="detail-action" onClick={() => void run(domain, 'media_previous_track')} disabled={pending || !entity}><SkipBack size={20} /><span>Previous</span></button>
              <button className="detail-action primary" onClick={() => void run(domain, entity?.state === 'playing' ? 'media_pause' : 'media_play')} disabled={pending || !entity}>{entity?.state === 'playing' ? <Pause size={20} /> : <Play size={20} />}<span>{entity?.state === 'playing' ? 'Pause' : 'Play'}</span></button>
              <button className="detail-action" onClick={() => void run(domain, 'media_next_track')} disabled={pending || !entity}><SkipForward size={20} /><span>Next</span></button>
            </div>
            <div className="brightness-control">
              <div><span><Volume2 size={18} /> Volume</span><strong>{volume}%</strong></div>
              <input type="range" min="0" max="100" defaultValue={volume} aria-label={`${config.label} volume`} disabled={pending || !entity} onPointerUp={(event) => void run(domain, 'volume_set', { volume_level: Number(event.currentTarget.value) / 100 })} />
            </div>
          </section>
        )}
        {domain === 'climate' && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <ThermostatKnob entity={entity} pending={pending} size="large" onSet={(value) => void run('climate', 'set_temperature', { temperature: value })} />
            {fanModes.length > 0 && <div className="mode-buttons" aria-label="Fan mode">{fanModes.map((mode) => <button key={mode} className={entity?.attributes.fan_mode === mode ? 'active' : ''} onClick={() => void run('climate', 'set_fan_mode', { fan_mode: mode })} disabled={pending || !entity}>{`Fan ${mode}`}</button>)}</div>}
            {hvacModes.length > 0 && <div className="mode-buttons" aria-label="HVAC mode">{hvacModes.map((mode) => <button key={mode} className={entity?.state === mode ? 'active' : ''} onClick={() => void run('climate', 'set_hvac_mode', { hvac_mode: mode })} disabled={pending || !entity}>{mode.replaceAll('_', ' ')}</button>)}</div>}
            {presetModes.length > 0 && <div className="mode-buttons" aria-label="Preset mode">{presetModes.map((mode) => <button key={mode} className={entity?.attributes.preset_mode === mode ? 'active' : ''} onClick={() => void run('climate', 'set_preset_mode', { preset_mode: mode })} disabled={pending || !entity}>{mode}</button>)}</div>}
          </section>
        )}
        {domain === 'fan' && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <div className="detail-action-grid two-column">
              <button className="detail-action primary" onClick={() => void run('fan', 'turn_on')} disabled={pending || !entity}><Wind size={20} /><span>Turn on</span></button>
              <button className="detail-action" onClick={() => void run('fan', 'turn_off')} disabled={pending || !entity}><Square size={18} /><span>Turn off</span></button>
            </div>
            <div className="brightness-control"><div><span><Wind size={18} /> Speed</span><strong>{fanPercentage}%</strong></div><input type="range" min="1" max="100" defaultValue={fanPercentage || 50} aria-label={`${config.label} speed`} disabled={pending || !entity} onPointerUp={(event) => void run('fan', 'set_percentage', { percentage: Number(event.currentTarget.value) })} /></div>
          </section>
        )}
        {domain === 'vacuum' && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <div className="detail-action-grid three-column">
              <button className="detail-action primary" onClick={() => void run('vacuum', 'start')} disabled={pending || !entity}><Play size={20} /><span>Clean</span></button>
              <button className="detail-action" onClick={() => void run('vacuum', 'pause')} disabled={pending || !entity}><Pause size={20} /><span>Pause</span></button>
              <button className="detail-action" onClick={() => void run('vacuum', 'return_to_base')} disabled={pending || !entity}><ChevronDown size={20} /><span>Dock</span></button>
            </div>
          </section>
        )}
        {(domain === 'scene' || domain === 'script') && (
          <section className="detail-controls" aria-label={`${config.label} controls`}>
            <button className="detail-action primary full-width" onClick={() => void run(domain, 'turn_on')} disabled={pending || !entity}><Send size={20} /><span>{domain === 'scene' ? 'Activate scene' : 'Run script'}</span></button>
          </section>
        )}
        {message && <p className="detail-error" role="alert">{message}</p>}
        {pending && <div className="detail-progress" role="status">Sending command</div>}
        {showsNetworkHistory && (
          <Suspense fallback={<div className="history-loading"><Activity size={18} /><span>Preparing network history</span></div>}>
            <NetworkDetail />
          </Suspense>
        )}
        {hasNumericHistory && entity && (
          <Suspense fallback={<div className="history-loading"><Activity size={18} /><span>Preparing history</span></div>}>
            <EntityHistory entityId={entity.entity_id} unit={unit} currentState={entity.state} />
          </Suspense>
        )}
        {!showsNetworkHistory && !hasNumericHistory && entity && ['light', 'switch', 'lock', 'cover', 'binary_sensor', 'media_player', 'vacuum', 'fan', 'climate'].includes(domain) && (
          <StateTimeline entityId={entity.entity_id} currentState={entity.state} formatState={(state) => formatEntityState(entity, state)} />
        )}
        <h3 className="detail-subheading">Details</h3>
        <div className="attribute-grid">
          {attributes.length ? attributes.map(([name, value]) => <div key={name}><span>{name.replaceAll('_', ' ')}</span><strong>{String(value)}</strong></div>) : <p>No additional attributes available.</p>}
        </div>
        {entity?.last_changed && <footer>Last changed {new Date(entity.last_changed).toLocaleString()}</footer>}
      </section>
    </div>
  )
}

function App() {
  const [activeSection, setActiveSection] = useState('home')
  const [now, setNow] = useState(new Date())
  const [expandedTile, setExpandedTile] = useState<TileConfig | null>(null)
  const [alerts, setAlerts] = useState<StateAlert[]>([])
  const [autoRotate, setAutoRotate] = useState(true)
  const [insightsSlide, setInsightsSlide] = useState(0)
  const [weatherSlide, setWeatherSlide] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarTouchedAt, setSidebarTouchedAt] = useState(0)
  const [securityOpen, setSecurityOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [eventLogOpen, setEventLogOpen] = useState(false)
  const [flightsSlide, setFlightsSlide] = useState(0)
  const [nightModeStatus, setNightModeStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle')
  const [nightModeMessage, setNightModeMessage] = useState('Locks, garage, and indoor lighting')
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
  const { entities, health, loading, error, callService, runNightMode } = useHomeAssistant(handleStateChange)
  const autoDimClass = useAutoDim(entities)

  const {
    sections: dashboardSections,
    nightModeIndoorLights,
    energyRatePerKwh,
    customized: configCustomized,
    save: saveDashboardConfig,
    saveEnergyRate,
    reset: resetDashboardConfig,
  } = useDashboardConfig()
  const section = dashboardSections.find((item) => item.id === activeSection) ?? dashboardSections[0]
  const insights = useInsights(activeSection === 'insights')
  const weatherSlideCount = 4
  const weatherRotationInterval = 10_000

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  // Insights advances through its own panels first, so it holds for slides x interval before the next section.
  useEffect(() => {
    // Any open sheet also blocks rotation: now that a pause expires on its own, the page could
    // otherwise slide out from behind whatever the user still has open.
    if (!autoRotate || expandedTile || configOpen || securityOpen || eventLogOpen) return
    const interval = activeSection === 'weather' || activeSection === 'flights' ? weatherRotationInterval : rotationInterval
    const timer = window.setTimeout(() => {
      if (activeSection === 'insights' && insightsSlide < insightsSlides.length - 1) {
        setInsightsSlide(insightsSlide + 1)
        return
      }
      if (activeSection === 'weather' && weatherSlide < weatherSlideCount - 1) {
        setWeatherSlide(weatherSlide + 1)
        return
      }
      if (activeSection === 'flights' && flightsSlide < flightsSlideCount - 1) {
        setFlightsSlide(flightsSlide + 1)
        return
      }
      const currentIndex = dashboardSections.findIndex((item) => item.id === activeSection)
      setInsightsSlide(0)
      setWeatherSlide(0)
      setFlightsSlide(0)
      setActiveSection(dashboardSections[(currentIndex + 1) % dashboardSections.length].id)
    }, interval)
    return () => window.clearTimeout(timer)
  }, [autoRotate, expandedTile, configOpen, securityOpen, eventLogOpen, activeSection, insightsSlide, weatherSlide, flightsSlide, dashboardSections])

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
    const timer = window.setTimeout(() => setSidebarOpen(false), 6_000)
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
    setAutoRotate(false)
    if (resumeTimer.current) window.clearTimeout(resumeTimer.current)
    resumeTimer.current = window.setTimeout(() => setAutoRotate(true), AUTO_RESUME_MS)
  }

  function toggleRotation() {
    if (resumeTimer.current) {
      window.clearTimeout(resumeTimer.current)
      resumeTimer.current = undefined
    }
    setAutoRotate((current) => !current)
  }

  /** Restarts the sidebar's hide countdown, rate-limited so pointer-move does not churn state. */
  function keepSidebarOpen() {
    setSidebarTouchedAt((current) => (Date.now() - current > 800 ? Date.now() : current))
  }

  // Touch-first navigation: horizontal swipes on the page move between sections.
  function handleSwipeStart(event: React.TouchEvent) {
    const target = event.target as Element
    swipeStart.current = target.closest('input, [role="slider"], .thermo-knob') ? null : { x: event.touches[0].clientX, y: event.touches[0].clientY }
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

  async function activateNightMode() {
    const confirmed = window.confirm(
      'Activate Night Mode? This will lock every available lock, close an open garage, and turn off approved indoor lights and safe lighting switches.',
    )
    if (!confirmed) return

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

  return (
    <div className={`command-center ${autoDimClass}`.trim()}>
      <div className="alert-stack" aria-live="polite" aria-atomic="false">
        {alerts.map((alert) => (
          <button key={alert.id} className={`state-alert ${alert.tone}`} onClick={() => setAlerts((current) => current.filter((item) => item.id !== alert.id))}>
            <span>{alert.tone === 'critical' ? <AlertTriangle size={22} /> : <BellRing size={22} />}</span>
            <div><strong>{alert.title}</strong><p>{alert.message}</p></div>
            <X size={17} />
          </button>
        ))}
      </div>
      {sidebarOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
      <aside
        className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}
        aria-hidden={sidebarOpen ? undefined : true}
        onPointerDown={keepSidebarOpen}
        onPointerMove={keepSidebarOpen}
        onFocusCapture={keepSidebarOpen}
      >
        <div className="brand" title="Home Panel"><span className="brand-mark"><Wind size={22} aria-hidden="true" /></span><span>Home Panel</span></div>
        <nav aria-label="Dashboard sections">
          {dashboardSections.map((item) => {
            const SectionIcon = sectionIcons[item.id] ?? Square
            return <button key={item.id} className={item.id === activeSection ? 'active' : ''} onClick={() => selectSection(item.id)}><SectionIcon size={20} aria-hidden="true" /><span>{item.label}</span></button>
          })}
        </nav>
        <button className="settings-button" onClick={() => { stopRotation(); setSidebarOpen(false); setConfigOpen(true) }} title="Customize dashboard tiles and Night Mode lights"><Wrench size={20} /><span>Configure{configCustomized ? '' : ' (default)'}</span></button>
      </aside>

      <main className={`${activeSection === 'weather' || activeSection === 'flights' ? 'is-fixed-view' : ''}${activeSection === 'insights' ? 'is-tall-view' : ''}`.trim()} onTouchStart={handleSwipeStart} onTouchEnd={handleSwipeEnd} onPointerDownCapture={(event) => {
        if (!(event.target as Element).closest('.rotation-status')) stopRotation()
      }}>
        <header className="topbar">
          <div className="page-title">
            <button
              className="nav-toggle"
              onClick={() => setSidebarOpen((open) => !open)}
              aria-expanded={sidebarOpen}
              aria-label={sidebarOpen ? 'Hide navigation' : 'Show navigation'}
              title={sidebarOpen ? 'Hide navigation' : 'Show navigation'}
            >
              {sidebarOpen ? <PanelLeftClose size={21} /> : <Menu size={21} />}
            </button>
            <div><p className="date">{now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</p><h1>{section.label}</h1></div>
          </div>
          <TrackedAircraftBadge entities={entities} />
          <div className="clock-block">
            <strong>{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</strong>
            <ConnectionStatus health={health} entities={entities} onOpen={stopRotation} />
            {/* Tucked into the far corner so the header's centre belongs to the flight. */}
            <div className="topbar-utilities">
              <button className="nav-toggle" onClick={() => { stopRotation(); setEventLogOpen(true) }} title="View activity log" aria-label="View activity log"><History size={16} /></button>
              <button className={`rotation-status ${autoRotate ? 'is-running' : ''}`} onClick={(event) => { event.stopPropagation(); toggleRotation() }} title={autoRotate ? 'Pause automatic page rotation' : 'Resume automatic page rotation'}><RotateCw size={13} /><span>{autoRotate ? (activeSection === 'insights' ? `${insightsSlide + 1}/${insightsSlides.length}` : activeSection === 'weather' ? `${weatherSlide + 1}/${weatherSlideCount}` : activeSection === 'flights' ? `${flightsSlide + 1}/${flightsSlideCount}` : '20s') : 'Paused'}</span></button>
            </div>
          </div>
        </header>

        {activeSection === 'home' && (
          <>
            <section className="moments-strip" aria-label="Home moments">
              <button
                className={`night-mode-moment is-${nightModeStatus}`}
                onClick={() => void activateNightMode()}
                disabled={nightModeStatus === 'pending' || !health?.home_assistant.connected}
              >
                <span className="moment-icon"><Moon size={21} aria-hidden="true" /></span>
                <span className="moment-copy"><strong>Night Mode</strong><small>{nightModeMessage}</small></span>
                <Lock size={17} aria-hidden="true" />
              </button>
              <button
                className="thermostat-quick"
                onClick={() => selectSection('climate')}
                aria-label="Open thermostat"
              >
                <span className="moment-icon thermo-accent"><Thermometer size={20} aria-hidden="true" /></span>
                <span className="moment-copy">
                  <strong>{entities.get('climate.mainfoor_thermostat') ? `${Math.round(Number(entities.get('climate.mainfoor_thermostat')?.attributes.temperature ?? 70))}°` : '--°'}</strong>
                  <small>{entities.get('climate.mainfoor_thermostat') ? `Now ${Math.round(Number(entities.get('climate.mainfoor_thermostat')?.attributes.current_temperature ?? 0))}° · ${String(entities.get('climate.mainfoor_thermostat')?.attributes.hvac_action ?? entities.get('climate.mainfoor_thermostat')?.state ?? 'idle')}` : 'Thermostat'}</small>
                </span>
              </button>
            </section>
            <UtilityRail entities={entities} activeSection={activeSection} autoRotate={autoRotate} onSelect={selectSection} onInspectSecurity={() => { stopRotation(); setSecurityOpen(true) }} now={now} />
          </>
        )}

        {(error || !health?.home_assistant.configured) && !loading && (
          <div className="status-banner" role="status"><Shield size={20} /><span>{error ?? 'Add HA_URL and HA_TOKEN to the Python backend to load live devices.'}</span></div>
        )}

        <div className="page-slide" key={activeSection}>
        {activeSection === 'insights' ? (
          <Suspense fallback={<div className="view-loading"><ChartNoAxesCombined size={24} /><span>Preparing insights</span></div>}>
            <InsightsView entities={entities} series={insights.series} loading={insights.loading} slide={insightsSlide} onSelectSlide={selectInsightsSlide} />
          </Suspense>
        ) : activeSection === 'world' ? (
          <WorldTimeMap now={now} />
        ) : activeSection === 'weather' ? (
          <WeatherView entities={entities} slide={weatherSlide} onSelectSlide={selectWeatherSlide} />
        ) : activeSection === 'flights' ? (
          <Suspense fallback={<div className="view-loading"><ChartNoAxesCombined size={24} /><span>Preparing flights</span></div>}>
            <FlightsView entities={entities} slide={flightsSlide} onSelectSlide={selectFlightsSlide} />
          </Suspense>
        ) : activeSection === 'energy' ? (
          <Suspense fallback={<div className="view-loading"><ChartNoAxesCombined size={24} /><span>Preparing energy usage</span></div>}>
            <EnergyView entities={entities} ratePerKwh={energyRatePerKwh} onSaveRate={saveEnergyRate} />
          </Suspense>
        ) : activeSection === 'volvo' ? (
          <Suspense fallback={<div className="view-loading"><ChartNoAxesCombined size={24} /><span>Preparing Volvo</span></div>}>
            <VolvoView entities={entities} />
          </Suspense>
        ) : (
          <section className="overview" aria-label={`${section.label} entities`}>
            {activeSection === 'climate' && entities.has('climate.mainfoor_thermostat') && (
              <div className="climate-hero">
                <ThermostatKnob entity={entities.get('climate.mainfoor_thermostat')} pending={false} size="large" onSet={(value) => void callService('climate', 'set_temperature', { entity_id: 'climate.mainfoor_thermostat', temperature: value })} />
              </div>
            )}
            <div className="section-heading">
              <div><span>My home</span><h2>{section.label} devices</h2></div>
              {activeSection === 'home' && <PresenceRow entities={entities} />}
              <p>{loading ? 'Loading entities...' : `${section.tiles.filter((tile) => entities.has(tile.entityId)).length} available`}</p>
            </div>
            <div className="entity-grid">
              {section.tiles.filter((tile) => !(activeSection === 'climate' && tile.entityId === 'climate.mainfoor_thermostat')).map((tile) => {
                const isDoorCount = tile.entityId === 'sensor.doors_open_count'
                return (
                  <EntityTile
                    key={tile.entityId}
                    config={tile}
                    entity={entities.get(tile.entityId)}
                    onService={callService}
                    onExpand={() => { stopRotation(); setExpandedTile(tile) }}
                    subtitle={isDoorCount ? openDoorSummary(entities) : undefined}
                    noSparkline={isDoorCount}
                  />
                )
              })}
            </div>
          </section>
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
        />
      )}
      {eventLogOpen && <EventLog events={events} onClose={() => setEventLogOpen(false)} />}
    </div>
  )
}

export default App
