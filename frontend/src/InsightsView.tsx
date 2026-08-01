import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  BatteryCharging, Bot, CloudSun, Droplets, Gauge, HeartPulse, Maximize2,
  Refrigerator, ShieldCheck, Sprout, Thermometer, TrendingUp, WashingMachine,
  Waves, Wifi, Wind, Zap,
} from 'lucide-react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend,
  RadialBar, RadialBarChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { HAEntity } from './types'
import type { HistoryPoint } from './useInsights'
import { insightsSlides } from './insightsSlides'
import { comfortScore, detailColors } from './insightDetails'
import type { DetailChip, DetailFactor, DetailSeries, InsightDetailConfig } from './insightDetails'
import { InsightsDetail } from './InsightsDetail'
import './InsightsView.css'

interface InsightsViewProps {
  entities: Map<string, HAEntity>
  series: Map<string, HistoryPoint[]>
  loading: boolean
  slide: number
  onSelectSlide: (slide: number) => void
}

interface SeriesDefinition {
  entityId: string
  key: string
  label: string
  color: string
}

interface ChartPoint {
  time: number
  [key: string]: number
}

const climateSeries: SeriesDefinition[] = [
  { entityId: 'sensor.main_floor_temperature', key: 'main', label: 'Main floor', color: '#ff8065' },
  { entityId: 'sensor.nursery_sensor_temperature', key: 'nursery', label: 'Nursery', color: '#78d58b' },
  { entityId: 'sensor.master_bedroom_master_bedroom_temperature_temperature', key: 'primary', label: 'Primary', color: '#7ba7d8' },
  { entityId: 'sensor.office_temperature_temperature_2', key: 'office', label: 'Office', color: '#bb8cff' },
  { entityId: 'sensor.media_sensor_temperature', key: 'media', label: 'Media', color: '#62d7d3' },
  { entityId: 'sensor.attic_sensor_temperature', key: 'attic', label: 'Attic', color: '#ffc857' },
  { entityId: 'sensor.guest_bedroom_sensor_temperature', key: 'guest', label: 'Guest', color: '#f18db8' },
]

const roomSensors = [
  { name: 'Main floor', temperature: 'sensor.main_floor_temperature', humidity: 'sensor.mainfoor_thermostat_humidity' },
  { name: 'Nursery', temperature: 'sensor.nursery_sensor_temperature', humidity: 'sensor.nursery_sensor_humidity' },
  { name: 'Primary', temperature: 'sensor.master_bedroom_master_bedroom_temperature_temperature', humidity: 'sensor.master_bedroom_master_bedroom_temperature_humidity' },
  { name: 'Office', temperature: 'sensor.office_temperature_temperature_2', humidity: 'sensor.office_temperature_humidity_2' },
  { name: 'Media room', temperature: 'sensor.media_sensor_temperature', humidity: 'sensor.media_sensor_humidity' },
  { name: 'Attic', temperature: 'sensor.attic_sensor_temperature', humidity: 'sensor.attic_sensor_humidity' },
  { name: 'Guest', temperature: 'sensor.guest_bedroom_sensor_temperature', humidity: 'sensor.guest_bedroom_sensor_humidity' },
]

const monthlyEnergyId = 'sensor.smarthub_energy_monthly_usage_3001575154_641_hickory_bend_trail_smarthub_energy_monthly_usage_3001575154_641_hickory_bend_trail'
const tooltipStyle = { borderRadius: 10, border: '1px solid var(--border)', background: '#0d1a25', color: 'var(--text)', fontSize: 11 }
const slideIcons: LucideIcon[] = [Thermometer, Wifi, HeartPulse]
const mbpsScale = 8 / 1024

function numericState(entities: Map<string, HAEntity>, entityId: string, fallback = 0) {
  const value = Number(entities.get(entityId)?.state)
  return Number.isFinite(value) ? value : fallback
}

function formatNumber(value: number, maximumFractionDigits = 0) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value)
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function humanState(value: string | undefined) {
  if (!value || value === 'unknown' || value === 'unavailable') return 'Unavailable'
  const text = value.replaceAll('_', ' ')
  return text.replace(/^./, (letter) => letter.toUpperCase())
}

function entityName(entity: HAEntity) {
  return String(entity.attributes.friendly_name ?? entity.entity_id.split('.')[1].replaceAll('_', ' '))
}

function mergeHistory(series: Map<string, HistoryPoint[]>, definitions: SeriesDefinition[], bucketMinutes = 10): ChartPoint[] {
  const bucketSize = bucketMinutes * 60_000
  const buckets = new Map<number, ChartPoint>()
  definitions.forEach(({ entityId, key }) => {
    ;(series.get(entityId) ?? []).forEach((point) => {
      const time = Math.round(point.time / bucketSize) * bucketSize
      const row = buckets.get(time) ?? { time }
      row[key] = point.value
      buckets.set(time, row)
    })
  })
  return Array.from(buckets.values()).sort((left, right) => left.time - right.time)
}

function toKwh(entity: HAEntity | undefined) {
  const value = Number(entity?.state)
  if (!Number.isFinite(value)) return 0
  return entity?.attributes.unit_of_measurement === 'Wh' ? value / 1000 : value
}

function PanelHeader({ icon: Icon, title, subtitle, value, onExpand }: { icon: LucideIcon; title: string; subtitle: string; value?: string; onExpand?: () => void }) {
  return (
    <header className="analytics-panel-header">
      <span><Icon size={18} /></span>
      <div><h3>{title}</h3><p>{subtitle}</p></div>
      {value && <strong>{value}</strong>}
      {onExpand && <button className="panel-expand" onClick={onExpand} title={`Explain ${title}`} aria-label={`Explain ${title}`}><Maximize2 size={14} /></button>}
    </header>
  )
}

function EmptyChart({ loading }: { loading: boolean }) {
  return <div className={`chart-empty ${loading ? 'is-loading' : ''}`}><TrendingUp size={24} /><span>{loading ? 'Loading recorder history' : 'More history will appear here'}</span></div>
}

export function InsightsView({ entities, series, loading, slide, onSelectSlide }: InsightsViewProps) {
  const [detail, setDetail] = useState<InsightDetailConfig | null>(null)
  const all = Array.from(entities.values())
  const inside = numericState(entities, 'sensor.main_floor_temperature', 72)
  const insideHumidity = numericState(entities, 'sensor.mainfoor_thermostat_humidity', 45)
  const outside = numericState(entities, 'sensor.open_weather_temperature', 72)
  const outsideHumidity = numericState(entities, 'sensor.open_weather_humidity', 45)
  const dashboardBattery = numericState(entities, 'sensor.dashboard_battery_level', 0)
  const download = numericState(entities, 'sensor.cbr750_gateway_download_speed', 0) * mbpsScale
  const upload = numericState(entities, 'sensor.cbr750_gateway_upload_speed', 0) * mbpsScale
  const salt = numericState(entities, 'sensor.esphome_web_79cc76_salt_level_percent', 0)
  const airQuality = numericState(entities, 'sensor.dyson_3wf_us_ugf5956a_air_quality_index', 0)
  const airQualityCategory = humanState(entities.get('sensor.dyson_3wf_us_ugf5956a_air_quality_category')?.state)
  const windSpeed = numericState(entities, 'sensor.open_weather_windspeed', 0)
  const magnoliaMoisture = numericState(entities, 'sensor.lawn_plant_sensor_magnolia_humidity', 0)
  const mapleMoisture = numericState(entities, 'sensor.lawn_plant_sensor_maple_humidity', 0)
  const monthlyEnergy = numericState(entities, monthlyEnergyId, 0)
  const fridgeThisMonth = toKwh(entities.get('sensor.refrigerator_energy_this_month'))
  const fridgeLastMonth = toKwh(entities.get('sensor.refrigerator_energy_last_month'))
  const washerThisMonth = toKwh(entities.get('sensor.washer_energy_this_month'))
  const washerLastMonth = toKwh(entities.get('sensor.washer_energy_last_month'))
  const comfort = comfortScore(inside, insideHumidity)
  const online = entities.get('binary_sensor.cbr750_gateway_wan_status')?.state === 'on'
  const unsafeLocks = all.filter((entity) => entity.entity_id.startsWith('lock.') && ['unlocked', 'open', 'jammed'].includes(entity.state))
  const activeProblems = all.filter((entity) => entity.entity_id.startsWith('binary_sensor.') && entity.attributes.device_class === 'problem' && entity.state === 'on')
  const leaks = all.filter((entity) => entity.entity_id.startsWith('binary_sensor.') && entity.attributes.device_class === 'moisture' && entity.state === 'on')
  const openDoorSensors = all.filter((entity) => entity.entity_id.startsWith('binary_sensor.')
    && ['door', 'garage_door', 'window', 'opening'].includes(String(entity.attributes.device_class ?? ''))
    && entity.state === 'on')
  const openCovers = all.filter((entity) => entity.entity_id.startsWith('cover.') && ['open', 'opening'].includes(entity.state))
  const reportedDoors = numericState(entities, 'sensor.doors_open_count', 0)
  const openDoors = Math.max(reportedDoors, openDoorSensors.length)
  const homeIssues = unsafeLocks.length + activeProblems.length + openDoors
  const vacuumTimeLeft = numericState(entities, 'sensor.roborock_qrevo_maxv_sensor_time_left')
  const fridgeTemperature = numericState(entities, 'number.refrigerator_fridge_temperature')
  const freezerTemperature = numericState(entities, 'number.refrigerator_freezer_temperature')

  /** Only chart entities that actually exist so detail panels never request missing history. */
  function seriesFor(entityId: string, label: string, color: string, scale?: number): DetailSeries[] {
    return entities.has(entityId) ? [{ entityId, label, color, ...(scale ? { scale } : {}) }] : []
  }

  const accessFactors: DetailFactor[] = [
    { label: 'Unlocked locks', value: `${unsafeLocks.length}`, detail: unsafeLocks.length ? unsafeLocks.map(entityName).slice(0, 2).join(', ') : 'All locks secured', tone: unsafeLocks.length ? 'danger' : 'good' },
    { label: 'Open doors', value: `${formatNumber(openDoors)}`, detail: openDoorSensors.length ? openDoorSensors.map(entityName).slice(0, 2).join(', ') : openDoors ? 'Reported by the door counter' : 'All doors closed', tone: openDoors ? 'warn' : 'good' },
    { label: 'Open covers', value: `${openCovers.length}`, detail: openCovers.length ? openCovers.map(entityName).slice(0, 2).join(', ') : 'Garage and covers closed', tone: openCovers.length ? 'warn' : 'good' },
    { label: 'Leak alerts', value: `${leaks.length}`, detail: leaks.length ? leaks.map(entityName)[0] : 'No moisture detected', tone: leaks.length ? 'danger' : 'good' },
    { label: 'Device problems', value: `${activeProblems.length}`, detail: activeProblems.length ? entityName(activeProblems[0]) : 'No reported faults', tone: activeProblems.length ? 'warn' : 'good' },
  ]
  const accessChips: DetailChip[] = [...openDoorSensors, ...openCovers, ...unsafeLocks, ...leaks, ...activeProblems]
    .slice(0, 8)
    .map((entity) => ({ label: entityName(entity), value: humanState(entity.state) }))

  const climateData = mergeHistory(series, climateSeries)
  const networkDefinitions: SeriesDefinition[] = [
    { entityId: 'sensor.cbr750_gateway_download_speed', key: 'download', label: 'Download', color: '#39df8b' },
    { entityId: 'sensor.cbr750_gateway_upload_speed', key: 'upload', label: 'Upload', color: '#55a8ff' },
  ]
  const networkData = mergeHistory(series, networkDefinitions, 5)
  const saltData = series.get('sensor.esphome_web_79cc76_salt_level_percent') ?? []

  const energyData = [
    { name: 'Home', current: monthlyEnergy, previous: 0 },
    { name: 'Fridge', current: fridgeThisMonth, previous: fridgeLastMonth },
    { name: 'Washer', current: washerThisMonth, previous: washerLastMonth },
  ]

  const batteryData = all
    .filter((entity) => entity.attributes.device_class === 'battery' && Number.isFinite(Number(entity.state)))
    .map((entity) => ({ entityId: entity.entity_id, name: entityName(entity).replace(/ battery( level)?/i, ''), value: Number(entity.state) }))
    .sort((left, right) => left.value - right.value)
    .slice(0, 8)

  const plantData = all
    .filter((entity) => {
      const searchable = `${entity.entity_id} ${entityName(entity)}`.toLowerCase()
      return entity.attributes.device_class === 'humidity' && /(plant|maple|magnolia|soil)/.test(searchable) && Number.isFinite(Number(entity.state))
    })
    .map((entity, index) => ({ entityId: entity.entity_id, name: entityName(entity).replace(/plant sensor|humidity/gi, '').trim(), value: Number(entity.state), fill: index % 2 ? '#62d7d3' : '#62d477' }))

  const roomData = roomSensors.map((room) => ({
    ...room,
    temperatureValue: numericState(entities, room.temperature, Number.NaN),
    humidityValue: numericState(entities, room.humidity, Number.NaN),
  }))

  const utilityReadings = [
    {
      icon: Thermometer, label: 'Inside', value: `${formatNumber(inside, 1)}°`, detail: `${formatNumber(insideHumidity)}% RH`, tone: '',
      detailConfig: {
        id: 'inside', title: 'Inside climate', subtitle: 'Main floor temperature and humidity', value: `${formatNumber(inside, 1)}°F`, unit: '°F', hours: 24, chart: 'area',
        series: [...seriesFor('sensor.main_floor_temperature', 'Inside temperature', detailColors.temperature)],
        explanation: 'Live main-floor thermostat temperature, charted from 24 hours of recorder history. Humidity is tracked by a separate sensor and shown below because it uses a different unit.',
        factors: [
          { label: 'Temperature', value: `${formatNumber(inside, 1)}°F`, detail: `${formatNumber(Math.abs(inside - 72), 1)}°F from 72°F target`, tone: Math.abs(inside - 72) > 4 ? 'warn' : 'good' },
          { label: 'Humidity', value: `${formatNumber(insideHumidity)}%`, detail: `${formatNumber(Math.abs(insideHumidity - 45))}% from 45% target`, tone: Math.abs(insideHumidity - 45) > 15 ? 'warn' : 'good' },
          { label: 'Outside temperature', value: `${formatNumber(outside, 1)}°F`, detail: `${formatNumber(inside - outside, 1)}°F difference` },
          { label: 'Comfort score', value: `${comfort}`, detail: 'Derived from both readings' },
        ] as DetailFactor[],
      } as InsightDetailConfig,
    },
    {
      icon: CloudSun, label: 'Outside', value: `${formatNumber(outside)}°`, detail: `${formatNumber(outsideHumidity)}% RH`, tone: '',
      detailConfig: {
        id: 'outside', title: 'Outside conditions', subtitle: 'OpenWeather observation feed', value: `${formatNumber(outside, 1)}°F`, unit: '°F', hours: 24, chart: 'area',
        series: [...seriesFor('sensor.open_weather_temperature', 'Outside temperature', detailColors.temperature)],
        explanation: 'Outdoor temperature reported by the OpenWeather integration for your location, charted over 24 hours. Humidity and wind come from the same integration and drive the weather tiles elsewhere on the dashboard.',
        factors: [
          { label: 'Temperature', value: `${formatNumber(outside, 1)}°F` },
          { label: 'Humidity', value: `${formatNumber(outsideHumidity)}%` },
          { label: 'Wind speed', value: `${formatNumber(windSpeed, 1)} mph` },
          { label: 'Inside difference', value: `${formatNumber(inside - outside, 1)}°F`, detail: inside > outside ? 'Warmer inside' : 'Cooler inside' },
        ] as DetailFactor[],
      } as InsightDetailConfig,
    },
    {
      icon: HeartPulse, label: 'Air quality', value: airQualityCategory, detail: `AQI ${formatNumber(airQuality)}`, tone: airQuality > 50 ? 'alert' : '',
      detailConfig: {
        id: 'air-quality', title: 'Indoor air quality', subtitle: 'Dyson purifier air quality index', value: `AQI ${formatNumber(airQuality)}`, unit: 'AQI', hours: 24, chart: 'area',
        series: [...seriesFor('sensor.dyson_3wf_us_ugf5956a_air_quality_index', 'Air quality index', detailColors.air)],
        explanation: 'The Dyson purifier reports a combined air quality index from its particulate and VOC sensors. Lower is cleaner: values at or below 50 are generally considered good, and the purifier assigns the descriptive category shown here.',
        factors: [
          { label: 'Index', value: formatNumber(airQuality), tone: airQuality > 50 ? 'warn' : 'good' },
          { label: 'Category', value: airQualityCategory },
          { label: 'Threshold', value: '50', detail: 'Above this is elevated' },
          { label: 'Inside humidity', value: `${formatNumber(insideHumidity)}%`, detail: 'Affects perceived air quality' },
        ] as DetailFactor[],
      } as InsightDetailConfig,
    },
    {
      icon: ShieldCheck, label: 'Access', value: homeIssues ? `${homeIssues} alerts` : 'Secure', detail: homeIssues ? 'Needs attention' : 'All clear', tone: homeIssues ? 'alert' : '',
      detailConfig: {
        id: 'access', title: 'Access and safety', subtitle: 'Locks, doors, leaks, and faults', value: homeIssues ? `${homeIssues} alerts` : 'Secure', unit: 'doors', hours: 24, chart: 'line',
        series: [...seriesFor('sensor.doors_open_count', 'Open doors', detailColors.access)],
        explanation: 'This counts unlocked locks, currently open doors, active leak sensors, and devices reporting a problem. The chart replays how many doors were open over the last 24 hours, so repeated spikes point to a door left ajar. Every entity behind the count is named in the related entities below.',
        factors: accessFactors,
        chips: accessChips,
      } as InsightDetailConfig,
    },
  ]

  const systems = [
    {
      icon: WashingMachine, label: 'Washer', value: humanState(entities.get('sensor.washer_current_status')?.state), detail: `${formatNumber(numericState(entities, 'sensor.washer_cycles'))} cycles`, tone: 'blue',
      detailConfig: {
        id: 'washer', title: 'Washer', subtitle: 'Cycle status and energy use', value: humanState(entities.get('sensor.washer_current_status')?.state), unit: '', hours: 24, chart: 'line',
        series: [...seriesFor('sensor.washer_current_status', 'Washer status', detailColors.neutral)],
        explanation: 'Washer status is a text state, so the panel lists recent state changes instead of a numeric trend. Lifetime cycle count and monthly energy come from the appliance integration and are useful for spotting unusually heavy use.',
        factors: [
          { label: 'Status', value: humanState(entities.get('sensor.washer_current_status')?.state) },
          { label: 'Lifetime cycles', value: formatNumber(numericState(entities, 'sensor.washer_cycles')) },
          { label: 'Energy this month', value: `${formatNumber(washerThisMonth, 2)} kWh` },
          { label: 'Energy last month', value: `${formatNumber(washerLastMonth, 2)} kWh` },
        ] as DetailFactor[],
      } as InsightDetailConfig,
    },
    {
      icon: Waves, label: 'Dryer', value: humanState(entities.get('sensor.dryer_current_status')?.state), detail: 'Laundry system', tone: 'amber',
      detailConfig: {
        id: 'dryer', title: 'Dryer', subtitle: 'Laundry cycle status', value: humanState(entities.get('sensor.dryer_current_status')?.state), unit: '', hours: 24, chart: 'line',
        series: [...seriesFor('sensor.dryer_current_status', 'Dryer status', detailColors.energy)],
        explanation: 'Dryer status is reported as text, so recent transitions are listed instead of a chart. Pair this with the washer panel to see whether a load finished washing but was never dried.',
        factors: [
          { label: 'Status', value: humanState(entities.get('sensor.dryer_current_status')?.state) },
          { label: 'Washer status', value: humanState(entities.get('sensor.washer_current_status')?.state), detail: 'Upstream appliance' },
        ] as DetailFactor[],
      } as InsightDetailConfig,
    },
    {
      icon: Refrigerator, label: 'Refrigerator', value: `${formatNumber(fridgeTemperature)}°F`, detail: `Freezer ${formatNumber(freezerTemperature)}°F`, tone: 'green',
      detailConfig: {
        id: 'refrigerator', title: 'Refrigerator', subtitle: 'Fridge and freezer setpoints', value: `${formatNumber(fridgeTemperature)}°F`, unit: '°F', hours: 24, chart: 'area',
        series: [...seriesFor('number.refrigerator_fridge_temperature', 'Fridge', detailColors.humidity), ...seriesFor('number.refrigerator_freezer_temperature', 'Freezer', detailColors.comfort)],
        explanation: 'Both values are the appliance temperature setpoints exposed by the integration. Sustained drift away from roughly 37°F fridge and 0°F freezer usually means a door was left open or the unit is struggling.',
        factors: [
          { label: 'Fridge', value: `${formatNumber(fridgeTemperature)}°F`, tone: fridgeTemperature > 42 ? 'warn' : 'good' },
          { label: 'Freezer', value: `${formatNumber(freezerTemperature)}°F`, tone: freezerTemperature > 5 ? 'warn' : 'good' },
          { label: 'Energy this month', value: `${formatNumber(fridgeThisMonth, 2)} kWh` },
          { label: 'Energy last month', value: `${formatNumber(fridgeLastMonth, 2)} kWh` },
        ] as DetailFactor[],
      } as InsightDetailConfig,
    },
    {
      icon: Bot, label: 'Roborock', value: humanState(entities.get('sensor.roborock_qrevo_maxv_status')?.state), detail: `${formatNumber(numericState(entities, 'sensor.roborock_qrevo_maxv_total_cleaning_count'))} cleanings`, tone: 'cyan',
      detailConfig: {
        id: 'roborock', title: 'Roborock vacuum', subtitle: 'Cleaning status and history', value: humanState(entities.get('sensor.roborock_qrevo_maxv_status')?.state), unit: '', hours: 24, chart: 'line',
        series: [...seriesFor('sensor.roborock_qrevo_maxv_status', 'Vacuum status', detailColors.comfort)],
        explanation: 'Vacuum status is a text state, so recent transitions between docked, cleaning, and returning are listed. Total cleaning count and remaining consumable life indicate when maintenance is due.',
        factors: [
          { label: 'Status', value: humanState(entities.get('sensor.roborock_qrevo_maxv_status')?.state) },
          { label: 'Total cleanings', value: formatNumber(numericState(entities, 'sensor.roborock_qrevo_maxv_total_cleaning_count')) },
          { label: 'Sensor life left', value: `${formatNumber(vacuumTimeLeft, 1)} h`, tone: vacuumTimeLeft < 0 ? 'danger' : 'good' },
        ] as DetailFactor[],
      } as InsightDetailConfig,
    },
    {
      icon: Gauge, label: 'Vacuum sensor', value: `${formatNumber(vacuumTimeLeft, 1)} h`, detail: 'Maintenance remaining', tone: vacuumTimeLeft < 0 ? 'coral' : 'green',
      detailConfig: {
        id: 'vacuum-sensor', title: 'Vacuum sensor life', subtitle: 'Consumable maintenance countdown', value: `${formatNumber(vacuumTimeLeft, 1)} h`, unit: 'h', hours: 24 * 7, chart: 'line',
        series: [...seriesFor('sensor.roborock_qrevo_maxv_sensor_time_left', 'Sensor hours left', detailColors.energy)],
        explanation: 'Roborock tracks remaining hours before its sensors need cleaning. The value counts down as the robot runs, and a negative number means the maintenance interval has already been exceeded.',
        factors: [
          { label: 'Hours remaining', value: `${formatNumber(vacuumTimeLeft, 1)} h`, tone: vacuumTimeLeft < 0 ? 'danger' : vacuumTimeLeft < 20 ? 'warn' : 'good' },
          { label: 'Total cleanings', value: formatNumber(numericState(entities, 'sensor.roborock_qrevo_maxv_total_cleaning_count')) },
          { label: 'Current status', value: humanState(entities.get('sensor.roborock_qrevo_maxv_status')?.state) },
        ] as DetailFactor[],
      } as InsightDetailConfig,
    },
    {
      icon: Wind, label: 'Wind', value: `${formatNumber(windSpeed, 1)} mph`, detail: 'Current outdoor speed', tone: 'cyan',
      detailConfig: {
        id: 'wind', title: 'Outdoor wind', subtitle: 'OpenWeather wind speed', value: `${formatNumber(windSpeed, 1)} mph`, unit: 'mph', hours: 24, chart: 'area',
        series: [...seriesFor('sensor.open_weather_windspeed', 'Wind speed', detailColors.comfort)],
        explanation: 'Wind speed from the OpenWeather integration over 24 hours. Sustained high wind often correlates with faster indoor heat loss and is worth checking before running outdoor devices.',
        factors: [
          { label: 'Wind speed', value: `${formatNumber(windSpeed, 1)} mph`, tone: windSpeed > 20 ? 'warn' : 'good' },
          { label: 'Outside temperature', value: `${formatNumber(outside, 1)}°F` },
          { label: 'Outside humidity', value: `${formatNumber(outsideHumidity)}%` },
        ] as DetailFactor[],
      } as InsightDetailConfig,
    },
    {
      icon: Waves, label: 'Softener salt', value: `${formatNumber(salt)}%`, detail: salt < 25 ? 'Refill soon' : 'Level healthy', tone: salt < 25 ? 'coral' : 'cyan',
      detailConfig: {
        id: 'salt', title: 'Water softener salt', subtitle: '30-day salt level trend', value: `${formatNumber(salt)}%`, unit: '%', hours: 24 * 30, chart: 'area',
        series: [...seriesFor('sensor.esphome_web_79cc76_salt_level_percent', 'Salt level', detailColors.salt)],
        explanation: 'An ESPHome distance sensor measures the salt remaining in the brine tank and converts it to a percentage. The 30-day slope shows your consumption rate, and each refill appears as a sharp step upward.',
        factors: [
          { label: 'Current level', value: `${formatNumber(salt)}%`, tone: salt < 25 ? 'danger' : salt < 40 ? 'warn' : 'good' },
          { label: 'Refill threshold', value: '25%', detail: 'Below this, plan a refill' },
          { label: 'History window', value: '30 days' },
        ] as DetailFactor[],
      } as InsightDetailConfig,
    },
    {
      icon: Sprout, label: 'Magnolia moisture', value: `${formatNumber(magnoliaMoisture)}%`, detail: magnoliaMoisture < 20 ? 'Dry · water needed' : magnoliaMoisture > 90 ? 'Saturated' : 'Healthy range', tone: magnoliaMoisture < 20 || magnoliaMoisture > 90 ? 'coral' : 'green',
      detailConfig: {
        id: 'magnolia', title: 'Magnolia soil moisture', subtitle: '7-day lawn sensor trend', value: `${formatNumber(magnoliaMoisture)}%`, unit: '%', hours: 24 * 7, chart: 'area',
        series: [...seriesFor('sensor.lawn_plant_sensor_magnolia_humidity', 'Magnolia moisture', detailColors.plant)],
        explanation: 'Soil moisture from the lawn plant sensor over 7 days. Below 20% indicates dry soil that needs water, and above 90% suggests saturation from rain or overwatering. Rain and irrigation appear as sudden rises.',
        factors: [
          { label: 'Moisture', value: `${formatNumber(magnoliaMoisture)}%`, tone: magnoliaMoisture < 20 || magnoliaMoisture > 90 ? 'danger' : 'good' },
          { label: 'Dry threshold', value: '20%' },
          { label: 'Saturated threshold', value: '90%' },
          { label: 'Maple comparison', value: `${formatNumber(mapleMoisture)}%`, detail: 'Other tracked plant' },
        ] as DetailFactor[],
      } as InsightDetailConfig,
    },
    {
      icon: Sprout, label: 'Maple moisture', value: `${formatNumber(mapleMoisture)}%`, detail: mapleMoisture < 20 ? 'Dry · water needed' : mapleMoisture > 90 ? 'Saturated' : 'Healthy range', tone: mapleMoisture < 20 || mapleMoisture > 90 ? 'coral' : 'green',
      detailConfig: {
        id: 'maple', title: 'Maple soil moisture', subtitle: '7-day lawn sensor trend', value: `${formatNumber(mapleMoisture)}%`, unit: '%', hours: 24 * 7, chart: 'area',
        series: [...seriesFor('sensor.lawn_plant_sensor_maple_humidity', 'Maple moisture', detailColors.plant)],
        explanation: 'Soil moisture from the maple lawn sensor over 7 days. Compare its slope with the magnolia sensor: if only one drops, the issue is local to that plant rather than the weather.',
        factors: [
          { label: 'Moisture', value: `${formatNumber(mapleMoisture)}%`, tone: mapleMoisture < 20 || mapleMoisture > 90 ? 'danger' : 'good' },
          { label: 'Dry threshold', value: '20%' },
          { label: 'Saturated threshold', value: '90%' },
          { label: 'Magnolia comparison', value: `${formatNumber(magnoliaMoisture)}%`, detail: 'Other tracked plant' },
        ] as DetailFactor[],
      } as InsightDetailConfig,
    },
    {
      icon: BatteryCharging, label: 'Lowest battery', value: batteryData.length ? `${formatNumber(batteryData[0].value)}%` : '—', detail: batteryData[0]?.name ?? 'No battery data', tone: (batteryData[0]?.value ?? 100) <= 20 ? 'coral' : 'green',
      detailConfig: {
        id: 'lowest-battery', title: batteryData[0] ? `${batteryData[0].name} battery` : 'Battery levels', subtitle: 'Device closest to needing service', value: batteryData.length ? `${formatNumber(batteryData[0].value)}%` : '—', unit: '%', hours: 24 * 7, chart: 'line',
        series: batteryData[0] ? [{ entityId: batteryData[0].entityId, label: batteryData[0].name, color: detailColors.battery }] : [],
        explanation: 'This is the lowest reported battery percentage across every Home Assistant device that exposes a battery. The 7-day slope estimates how quickly it is draining so you can replace it before the device goes offline.',
        factors: [
          { label: 'Lowest level', value: batteryData.length ? `${formatNumber(batteryData[0].value)}%` : '—', detail: batteryData[0]?.name, tone: (batteryData[0]?.value ?? 100) <= 20 ? 'danger' : 'good' },
          { label: 'Devices tracked', value: `${all.filter((entity) => entity.attributes.device_class === 'battery').length}` },
          { label: 'Below 20%', value: `${batteryData.filter((item) => item.value <= 20).length}` },
          { label: 'Wall tablet', value: `${formatNumber(dashboardBattery)}%` },
        ] as DetailFactor[],
        chips: batteryData.slice(0, 6).map((item) => ({ label: item.name, value: `${formatNumber(item.value)}%` })),
      } as InsightDetailConfig,
    },
  ]

  const metrics = [
    {
      label: 'Comfort score', value: `${comfort}`, detail: `${formatNumber(inside, 1)}° · ${formatNumber(insideHumidity)}% inside`, icon: HeartPulse, tone: 'coral',
      detailConfig: {
        id: 'comfort', title: 'Comfort score', subtitle: 'Derived indoor comfort index', value: `${comfort}`, unit: 'score', hours: 24, chart: 'area', derived: 'comfort',
        series: [
          ...seriesFor('sensor.main_floor_temperature', 'Inside temperature', detailColors.comfort),
          ...seriesFor('sensor.mainfoor_thermostat_humidity', 'Inside humidity', detailColors.humidity),
        ],
        explanation: 'Comfort starts at 100 and subtracts 4 points for every °F away from a 72°F target plus 0.8 points for every percent away from 45% relative humidity. The trend replays 24 hours of temperature and humidity history through the same formula, so dips show when the house drifted out of the comfortable band.',
        factors: [
          { label: 'Inside temperature', value: `${formatNumber(inside, 1)}°F`, detail: `${formatNumber(Math.abs(inside - 72), 1)}°F from target`, tone: Math.abs(inside - 72) > 4 ? 'warn' : 'good' },
          { label: 'Inside humidity', value: `${formatNumber(insideHumidity)}%`, detail: `${formatNumber(Math.abs(insideHumidity - 45))}% from target`, tone: Math.abs(insideHumidity - 45) > 15 ? 'warn' : 'good' },
          { label: 'Temperature penalty', value: `-${formatNumber(Math.abs(inside - 72) * 4)}`, detail: '4 points per °F' },
          { label: 'Humidity penalty', value: `-${formatNumber(Math.abs(insideHumidity - 45) * .8)}`, detail: '0.8 points per %' },
        ] as DetailFactor[],
        chips: [{ label: 'Target', value: '72°F · 45% RH' }, { label: 'Outside', value: `${formatNumber(outside, 1)}°F` }],
      } as InsightDetailConfig,
    },
    {
      label: 'Home status', value: homeIssues ? `${homeIssues} alerts` : 'Secure', detail: unsafeLocks.length ? `${unsafeLocks.length} locks unlocked` : activeProblems.length ? `${activeProblems.length} device problems` : 'All monitored access clear', icon: ShieldCheck, tone: homeIssues ? 'coral' : 'green',
      detailConfig: {
        id: 'home-status', title: 'Home status', subtitle: 'Combined security and fault count', value: homeIssues ? `${homeIssues} alerts` : 'Secure', unit: 'doors', hours: 24, chart: 'line',
        series: [...seriesFor('sensor.doors_open_count', 'Open doors', detailColors.access)],
        explanation: 'Home status sums unlocked locks, open doors, and devices reporting a problem into a single number, so a value of zero means every monitored access point and device is healthy. The chart shows the open-door count over 24 hours.',
        factors: accessFactors,
        chips: accessChips,
      } as InsightDetailConfig,
    },
    {
      label: 'Network', value: online ? 'Online' : 'Offline', detail: `${formatNumber(download)}↓ · ${formatNumber(upload)}↑ Mbps`, icon: Wifi, tone: online ? 'blue' : 'coral',
      detailConfig: {
        id: 'network', title: 'Network throughput', subtitle: 'Gateway upload and download', value: `${formatNumber(download)}↓ / ${formatNumber(upload)}↑ Mbps`, unit: 'Mbps', hours: 24, chart: 'area',
        series: [
          ...seriesFor('sensor.cbr750_gateway_download_speed', 'Download', detailColors.download, mbpsScale),
          ...seriesFor('sensor.cbr750_gateway_upload_speed', 'Upload', detailColors.upload, mbpsScale),
        ],
        explanation: 'The gateway reports throughput in KiB/s, which the dashboard converts to Mbps by multiplying by 8 and dividing by 1024. Online status comes from the WAN connectivity sensor, so a flat line at zero with an offline status means the link itself dropped.',
        factors: [
          { label: 'WAN status', value: online ? 'Online' : 'Offline', tone: online ? 'good' : 'danger' },
          { label: 'Download', value: `${formatNumber(download, 1)} Mbps` },
          { label: 'Upload', value: `${formatNumber(upload, 1)} Mbps` },
          { label: 'Conversion', value: '× 8 ÷ 1024', detail: 'KiB/s to Mbps' },
        ] as DetailFactor[],
      } as InsightDetailConfig,
    },
    {
      label: 'Monthly energy', value: `${formatNumber(monthlyEnergy, 1)} kWh`, detail: `Est. $${formatNumber(monthlyEnergy * .12, 2)} at $0.12/kWh`, icon: Zap, tone: 'amber',
      detailConfig: {
        id: 'energy', title: 'Monthly energy', subtitle: 'Utility meter and appliance usage', value: `${formatNumber(monthlyEnergy, 1)} kWh`, unit: 'kWh', hours: 24 * 30, chart: 'area',
        series: [...seriesFor(monthlyEnergyId, 'Monthly usage', detailColors.energy)],
        explanation: 'Total usage reported by the SmartHub utility meter for the current billing month, charted across 30 days. The cost estimate simply multiplies usage by $0.12 per kWh, so adjust that rate mentally if your tariff differs.',
        factors: [
          { label: 'Home usage', value: `${formatNumber(monthlyEnergy, 1)} kWh` },
          { label: 'Estimated cost', value: `$${formatNumber(monthlyEnergy * .12, 2)}`, detail: 'At $0.12 per kWh' },
          { label: 'Refrigerator', value: `${formatNumber(fridgeThisMonth, 2)} kWh`, detail: `Last month ${formatNumber(fridgeLastMonth, 2)} kWh` },
          { label: 'Washer', value: `${formatNumber(washerThisMonth, 2)} kWh`, detail: `Last month ${formatNumber(washerLastMonth, 2)} kWh` },
        ] as DetailFactor[],
      } as InsightDetailConfig,
    },
  ]

  function roomDetail(room: typeof roomData[number]): InsightDetailConfig {
    return {
      id: `room-${room.temperature}`,
      title: `${room.name} climate`,
      subtitle: 'Room temperature and humidity',
      value: Number.isFinite(room.temperatureValue) ? `${formatNumber(room.temperatureValue, 1)}°F` : 'Unavailable',
      unit: '°F',
      hours: 24,
      chart: 'area',
      series: seriesFor(room.temperature, `${room.name} temperature`, detailColors.temperature),
      explanation: `Temperature history for the ${room.name.toLowerCase()} sensor over 24 hours. Comparing this against the whole-home overlay shows whether one room runs consistently hotter or colder, which usually points to airflow or insulation rather than the thermostat.`,
      factors: [
        { label: 'Temperature', value: Number.isFinite(room.temperatureValue) ? `${formatNumber(room.temperatureValue, 1)}°F` : '—', detail: Number.isFinite(room.temperatureValue) ? `${formatNumber(room.temperatureValue - inside, 1)}°F vs main floor` : undefined },
        { label: 'Humidity', value: Number.isFinite(room.humidityValue) ? `${formatNumber(room.humidityValue)}%` : '—' },
        { label: 'Main floor', value: `${formatNumber(inside, 1)}°F`, detail: 'Reference room' },
        { label: 'Outside', value: `${formatNumber(outside, 1)}°F` },
      ],
    }
  }

  const activeSlide = insightsSlides[slide] ?? insightsSlides[0]
  const SlideIcon = slideIcons[slide] ?? Thermometer

  const climatePanelDetail: InsightDetailConfig = {
    id: 'climate-overlay', title: 'Whole-home temperature', subtitle: 'Seven rooms over 24 hours', value: `${formatNumber(inside, 1)}°F main floor`, unit: '°F', hours: 24, chart: 'area',
    series: climateSeries.flatMap((item) => seriesFor(item.entityId, item.label, item.color)),
    explanation: 'Every monitored room temperature on one axis, sampled from recorder history into 10-minute buckets. Rooms that diverge from the group indicate uneven heating or cooling; rooms that move together are responding to the thermostat or outside weather.',
    factors: roomData.slice(0, 4).map((room) => ({
      label: room.name,
      value: Number.isFinite(room.temperatureValue) ? `${formatNumber(room.temperatureValue, 1)}°F` : '—',
      detail: Number.isFinite(room.humidityValue) ? `${formatNumber(room.humidityValue)}% RH` : undefined,
    })),
    chips: roomData.slice(4).map((room) => ({ label: room.name, value: Number.isFinite(room.temperatureValue) ? `${formatNumber(room.temperatureValue, 1)}°F` : '—' })),
  }

  const batteryPanelDetail: InsightDetailConfig = {
    id: 'battery-overview', title: 'Battery health', subtitle: 'Lowest devices over 7 days', value: batteryData.length ? `${formatNumber(batteryData[0].value)}% lowest` : '—', unit: '%', hours: 24 * 7, chart: 'line',
    series: batteryData.slice(0, 4).map((item, index) => ({ entityId: item.entityId, label: item.name, color: [detailColors.access, detailColors.energy, detailColors.plant, detailColors.humidity][index] })),
    explanation: 'The four lowest batteries charted over 7 days. A steep downward slope means the cell is failing rather than simply being old, and anything under 20% should be replaced before the device stops reporting.',
    factors: batteryData.slice(0, 4).map((item) => ({ label: item.name, value: `${formatNumber(item.value)}%`, tone: item.value <= 20 ? 'danger' : item.value <= 40 ? 'warn' : 'good' })),
    chips: batteryData.slice(4).map((item) => ({ label: item.name, value: `${formatNumber(item.value)}%` })),
  }

  const plantPanelDetail: InsightDetailConfig = {
    id: 'plant-overview', title: 'Plant moisture', subtitle: 'Soil saturation over 7 days', value: `${plantData.length} plants tracked`, unit: '%', hours: 24 * 7, chart: 'area',
    series: plantData.slice(0, 4).map((item, index) => ({ entityId: item.entityId, label: item.name, color: [detailColors.plant, detailColors.comfort, detailColors.humidity, detailColors.energy][index] })),
    explanation: 'Soil moisture for each lawn sensor over 7 days. Healthy soil generally sits between 20% and 90%; simultaneous rises across plants indicate rain or irrigation, while a single falling line means that plant needs water.',
    factors: plantData.map((item) => ({ label: item.name, value: `${formatNumber(item.value)}%`, detail: item.value < 20 ? 'Dry' : item.value > 90 ? 'Saturated' : 'Healthy', tone: item.value < 20 || item.value > 90 ? 'danger' : 'good' })),
  }

  return (
    <section className="insights-view" aria-label="Home analytics">
      <div className="metric-grid">
        {metrics.map(({ label, value, detail, icon: Icon, tone, detailConfig }) => (
          <button className="metric-card" key={label} onClick={() => setDetail(detailConfig)} aria-label={`Explain ${label}`}>
            <span className={`metric-icon ${tone}`}><Icon size={18} /></span>
            <div><p>{label}</p><strong>{value}</strong><small>{detail}</small></div>
            <Maximize2 className="card-expand" size={13} aria-hidden="true" />
          </button>
        ))}
      </div>

      <div className="slide-titlebar">
        <div><span className="slide-badge"><SlideIcon size={16} /></span><div><h2>{activeSlide.title}</h2><p>{activeSlide.subtitle}</p></div></div>
        <div className="slide-dots" role="tablist" aria-label="Insights panels">
          {insightsSlides.map((item, index) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={index === slide}
              aria-label={item.title}
              className={index === slide ? 'is-active' : ''}
              onClick={() => onSelectSlide(index)}
            />
          ))}
        </div>
      </div>

      {activeSlide.id === 'climate' && (
        <div className="insight-slide climate-slide" key="climate">
          <div className="utility-band">
            {utilityReadings.map(({ icon: Icon, label, value, detail, tone, detailConfig }) => (
              <button className={`utility-reading ${tone}`} key={label} onClick={() => setDetail(detailConfig)} aria-label={`Explain ${label}`}>
                <Icon size={17} /><span>{label}</span><strong>{value}</strong><small>{detail}</small>
              </button>
            ))}
          </div>
          <article className="analytics-panel">
            <PanelHeader icon={Thermometer} title="Room temperature · 24 hours" subtitle="Seven monitored spaces" value={`${formatNumber(outside)}° outside`} onExpand={() => setDetail(climatePanelDetail)} />
            <div className="chart-frame">
              {climateData.length > 1 ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={climateData} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}><defs>{climateSeries.map((item) => <linearGradient key={item.key} id={`climateFill-${item.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={item.color} stopOpacity={.26} /><stop offset="95%" stopColor={item.color} stopOpacity={.01} /></linearGradient>)}</defs><CartesianGrid stroke="rgba(100,145,165,.16)" vertical={false} /><XAxis dataKey="time" tickFormatter={formatTime} tick={{ fontSize: 11, fill: 'var(--muted)' }} axisLine={false} tickLine={false} minTickGap={38} /><YAxis tick={{ fontSize: 11, fill: 'var(--muted)' }} axisLine={false} tickLine={false} domain={['auto', 'auto']} /><Tooltip labelFormatter={(label) => formatTime(Number(label))} contentStyle={tooltipStyle} /><Legend wrapperStyle={{ fontSize: 11 }} />{climateSeries.map((item) => <Area key={item.key} type="monotone" dataKey={item.key} name={item.label} stroke={item.color} strokeWidth={2} fill={`url(#climateFill-${item.key})`} dot={false} connectNulls />)}</AreaChart></ResponsiveContainer> : <EmptyChart loading={loading} />}
            </div>
          </article>
          <div className="room-grid">
            {roomData.map((room) => (
              <button className="room-card" key={room.name} onClick={() => setDetail(roomDetail(room))} aria-label={`Explain ${room.name} climate`}>
                <h3>{room.name}</h3>
                <div><span><Thermometer size={14} />{Number.isFinite(room.temperatureValue) ? `${formatNumber(room.temperatureValue, 1)}°` : '—'}</span><span><Droplets size={14} />{Number.isFinite(room.humidityValue) ? `${formatNumber(room.humidityValue)}%` : '—'}</span></div>
              </button>
            ))}
          </div>
        </div>
      )}

      {activeSlide.id === 'network' && (
        <div className="insight-slide network-slide" key="network">
          <article className="analytics-panel">
            <PanelHeader icon={Wifi} title="Network throughput · 24 hours" subtitle="Gateway traffic converted to Mbps" value={`${formatNumber(download)}↓ / ${formatNumber(upload)}↑`} onExpand={() => setDetail(metrics[2].detailConfig)} />
            <div className="chart-frame">
              {networkData.length > 1 ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={networkData} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}><defs><linearGradient id="downloadFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#39df8b" stopOpacity={.42} /><stop offset="95%" stopColor="#39df8b" stopOpacity={.02} /></linearGradient><linearGradient id="uploadFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#55a8ff" stopOpacity={.38} /><stop offset="95%" stopColor="#55a8ff" stopOpacity={.02} /></linearGradient></defs><CartesianGrid stroke="rgba(100,145,165,.16)" vertical={false} /><XAxis dataKey="time" tickFormatter={formatTime} tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} minTickGap={38} /><YAxis tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} /><Tooltip labelFormatter={(label) => formatTime(Number(label))} contentStyle={tooltipStyle} /><Legend wrapperStyle={{ fontSize: 10 }} /><Area type="monotone" dataKey="download" name="Download Mbps" stroke="#39df8b" fill="url(#downloadFill)" strokeWidth={2} connectNulls /><Area type="monotone" dataKey="upload" name="Upload Mbps" stroke="#55a8ff" fill="url(#uploadFill)" strokeWidth={2} connectNulls /></AreaChart></ResponsiveContainer> : <EmptyChart loading={loading} />}
            </div>
          </article>
          <div className="slide-row two">
            <article className="analytics-panel">
              <PanelHeader icon={Zap} title="Energy comparison" subtitle="Current vs previous month" value={`${formatNumber(monthlyEnergy, 1)} kWh`} onExpand={() => setDetail(metrics[3].detailConfig)} />
              <div className="chart-frame"><ResponsiveContainer width="100%" height="100%"><BarChart data={energyData} margin={{ top: 8, right: 5, left: -18, bottom: 0 }}><CartesianGrid stroke="rgba(100,145,165,.16)" vertical={false} /><XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} /><YAxis tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} /><Tooltip contentStyle={tooltipStyle} formatter={(value) => `${formatNumber(Number(value), 2)} kWh`} /><Legend wrapperStyle={{ fontSize: 10 }} /><Bar dataKey="current" name="This month" fill="#ffc857" radius={[5, 5, 0, 0]} /><Bar dataKey="previous" name="Last month" fill="#3f6680" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div>
            </article>
            <article className="analytics-panel">
              <PanelHeader icon={Waves} title="Water softener salt" subtitle="30-day recorder history" value={`${formatNumber(salt)}%`} onExpand={() => setDetail(systems[6].detailConfig)} />
              <div className="chart-frame">
                {saltData.length > 1 ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={saltData} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}><defs><linearGradient id="saltFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#32d5e2" stopOpacity={.42} /><stop offset="95%" stopColor="#32d5e2" stopOpacity={.03} /></linearGradient></defs><CartesianGrid stroke="rgba(100,145,165,.16)" vertical={false} /><XAxis dataKey="time" tickFormatter={(value) => new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' })} tick={{ fontSize: 9, fill: 'var(--muted)' }} axisLine={false} tickLine={false} minTickGap={30} /><YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} /><Tooltip labelFormatter={(label) => new Date(Number(label)).toLocaleDateString()} contentStyle={tooltipStyle} /><Area type="stepAfter" dataKey="value" name="Salt %" stroke="#32d5e2" fill="url(#saltFill)" strokeWidth={2} /></AreaChart></ResponsiveContainer> : <EmptyChart loading={loading} />}
              </div>
            </article>
          </div>
        </div>
      )}

      {activeSlide.id === 'health' && (
        <div className="insight-slide health-slide" key="health">
          <div className="slide-row two">
            <article className="analytics-panel">
              <PanelHeader icon={BatteryCharging} title="Lowest batteries" subtitle={`${batteryData.length} devices nearest service`} value={`${formatNumber(dashboardBattery)}% tablet`} onExpand={() => setDetail(batteryPanelDetail)} />
              <div className="chart-frame"><ResponsiveContainer width="100%" height="100%"><BarChart data={batteryData} layout="vertical" margin={{ top: 4, right: 18, left: 8, bottom: 0 }}><CartesianGrid stroke="rgba(100,145,165,.14)" horizontal={false} /><XAxis type="number" domain={[0, 100]} hide /><YAxis type="category" dataKey="name" width={94} tick={{ fontSize: 9, fill: 'var(--muted)' }} axisLine={false} tickLine={false} /><Tooltip contentStyle={tooltipStyle} formatter={(value) => `${value}%`} /><Bar dataKey="value" radius={[0, 5, 5, 0]}>{batteryData.map((entry) => <Cell key={entry.name} fill={entry.value <= 20 ? '#ff6469' : entry.value <= 40 ? '#ffc857' : '#55c982'} />)}</Bar></BarChart></ResponsiveContainer></div>
            </article>
            <article className="analytics-panel plant-panel">
              <PanelHeader icon={Sprout} title="Plant moisture" subtitle="Live lawn sensor saturation" value={`${plantData.length} plants`} onExpand={() => setDetail(plantPanelDetail)} />
              <div className="plant-chart-layout">
                <div className="chart-frame">{plantData.length ? <ResponsiveContainer width="100%" height="100%"><RadialBarChart innerRadius="28%" outerRadius="100%" data={plantData} startAngle={180} endAngle={0}><RadialBar dataKey="value" background cornerRadius={6} /><Tooltip contentStyle={tooltipStyle} formatter={(value) => `${value}%`} /></RadialBarChart></ResponsiveContainer> : <EmptyChart loading={false} />}</div>
                <div className="plant-readings">
                  {plantData.map((plant, index) => (
                    <button key={plant.name} onClick={() => setDetail(index === 0 ? systems[7].detailConfig : systems[8].detailConfig)} aria-label={`Explain ${plant.name} moisture`}>
                      <span style={{ background: plant.fill }} />
                      <p><strong>{plant.name}</strong><small>{formatNumber(plant.value)}% moisture</small></p>
                      <em className={plant.value < 20 || plant.value > 90 ? 'alert' : ''}>{plant.value < 20 ? 'Dry' : plant.value > 90 ? 'Saturated' : 'Healthy'}</em>
                    </button>
                  ))}
                </div>
              </div>
            </article>
          </div>
          <div className="system-grid">
            {systems.map(({ icon: Icon, label, value, detail, tone, detailConfig }) => (
              <button key={label} className={`system-card ${tone}`} onClick={() => setDetail(detailConfig)} aria-label={`Explain ${label}`}>
                <span><Icon size={18} /></span>
                <div><p>{label}</p><strong>{value}</strong><small>{detail}</small></div>
              </button>
            ))}
          </div>
        </div>
      )}

      {detail && <InsightsDetail config={detail} onClose={() => setDetail(null)} />}
    </section>
  )
}
