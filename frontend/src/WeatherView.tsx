import {
  Cloud,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Droplets,
  Sun,
  Umbrella,
  Wind,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { apiUrl } from './api'
import { RadarPanel } from './RadarPanel'
import type { RadarOutlook } from './RadarPanel'
import { tabListKeyHandler } from './tablist'
import type { HAEntity } from './types'
import { EmptyState, InlineError, LoadingState } from './ui/StateMessages'
import { WeatherAtmosphere } from './WeatherAtmosphere'
import { skyTheme } from './weatherTheme'
import './WeatherView.css'

type ForecastEntry = {
  datetime: string
  condition: string
  temperature: number | null
  templow: number | null
  precipitation: number | null
  precipitation_probability: number | null
  wind_speed: number | null
}

type ExternalHourly = {
  time: string
  temperature: number | null
  rainChance: number | null
  precipitation: number | null
  condition: string
  uv: number | null
  windSpeed: number | null
}

type ExternalDaily = {
  date: string
  temperatureMax: number | null
  temperatureMin: number | null
  rainTotal: number | null
  rainChance: number | null
  uvMax: number | null
  condition: string
  sunrise: string | null
  sunset: string | null
}

type ExternalWeatherPayload = {
  provider: string
  timezone: string | null
  precipitationUnit: string
  current: {
    time: string | null
    temperature: number | null
    apparentTemperature: number | null
    humidity: number | null
    precipitation: number | null
    windSpeed: number | null
    windGusts: number | null
    uv: number | null
    isDay: number | null
    condition: string
  }
  hourly: ExternalHourly[]
  daily: ExternalDaily[]
}

interface WeatherViewProps {
  entities: Map<string, HAEntity>
  slide: number
  onSelectSlide: (index: number) => void
}

function toNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeCondition(condition: string) {
  return condition.replaceAll('_', ' ').toLowerCase()
}

/** Sentence case in code rather than `text-transform`, which also capitalised units. */
function conditionLabel(condition: string) {
  return normalizeCondition(condition).replace(/^./, (letter) => letter.toUpperCase())
}

const PANELS = ['Today', 'Hourly', '6-day', 'Radar'] as const
const PANEL_INDEXES = PANELS.map((_, index) => index)
const TABPANEL_ID = 'weather-tabpanel'
const tabId = (index: number) => `weather-tab-${index}`

function getConditionIcon(condition: string) {
  const value = normalizeCondition(condition)
  if (/(lightning|thunder|storm)/.test(value)) return 'storm'
  if (/(snow|sleet|hail|blizzard|flurr)/.test(value)) return 'snow'
  if (/(rain|drizzle|shower|pour)/.test(value)) return 'rain'
  if (/(fog|mist|haze|smoke)/.test(value)) return 'fog'
  if (/(partly|mostly|cloud)/.test(value)) return 'cloudy'
  if (/(clear|sunny)/.test(value)) return 'sunny'
  return 'default'
}

function renderConditionIcon(condition: string, size: number) {
  const iconKey = getConditionIcon(condition)
  if (iconKey === 'storm') return <CloudLightning size={size} />
  if (iconKey === 'snow') return <CloudSnow size={size} />
  if (iconKey === 'rain') return <CloudRain size={size} />
  if (iconKey === 'fog') return <CloudFog size={size} />
  if (iconKey === 'cloudy') return <CloudSun size={size} />
  if (iconKey === 'sunny') return <Sun size={size} />
  return <Cloud size={size} />
}

function dayLabel(dateLike: string) {
  const date = new Date(dateLike)
  if (Number.isNaN(date.getTime())) return 'Day'
  return date.toLocaleDateString([], { weekday: 'short' })
}

function formatTemperature(value: number | null) {
  return value === null ? '--' : `${Math.round(value)}°`
}

function formatHour(dateLike: string) {
  const date = new Date(dateLike)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleTimeString([], { hour: 'numeric' })
}

function formatClock(dateLike: string | null) {
  if (!dateLike) return '--'
  const date = new Date(dateLike)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * Local calendar day for a timestamp. `toISOString()` cannot be used here: open-meteo returns
 * wall-clock times for the requested location, so converting them to UTC pushed every evening
 * hour onto tomorrow's date and emptied the hourly panel from late afternoon onward.
 */
function localDayIso(dateLike: string) {
  const date = new Date(dateLike)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function fromAttributesNumber(entity: HAEntity | undefined, key: string) {
  return toNumber(entity?.attributes[key])
}

function todayIsoLocal() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function WeatherView({ entities, slide, onSelectSlide }: WeatherViewProps) {
  const [externalData, setExternalData] = useState<ExternalWeatherPayload | null>(null)
  const [externalError, setExternalError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const weather = entities.get('weather.forecast_home') ?? Array.from(entities.values()).find((entity) => entity.entity_id.startsWith('weather.'))
  const outsideTemp = entities.get('sensor.open_weather_temperature')
  const humidity = entities.get('sensor.open_weather_humidity')
  const wind = entities.get('sensor.open_weather_windspeed')
  const homeZone = entities.get('zone.home')

  const latitude = useMemo(() => {
    const candidates = [
      fromAttributesNumber(weather, 'latitude'),
      fromAttributesNumber(homeZone, 'latitude'),
    ]
    return candidates.find((value) => value !== null) ?? null
  }, [homeZone, weather])

  const longitude = useMemo(() => {
    const candidates = [
      fromAttributesNumber(weather, 'longitude'),
      fromAttributesNumber(homeZone, 'longitude'),
    ]
    return candidates.find((value) => value !== null) ?? null
  }, [homeZone, weather])

  // Match whatever Home Assistant reports in, so one screen never shows 27° beside 81 °F.
  const units = String(outsideTemp?.attributes.unit_of_measurement ?? '').includes('C') ? 'metric' : 'imperial'

  useEffect(() => {
    if (latitude === null || longitude === null) return

    const abort = new AbortController()

    fetch(apiUrl(`weather/external?latitude=${latitude}&longitude=${longitude}&units=${units}`), { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Weather source unavailable (${response.status})`)
        const payload: ExternalWeatherPayload = await response.json()
        setExternalData(payload)
        setExternalError(null)
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name === 'AbortError') return
        setExternalError(error instanceof Error ? error.message : 'External weather failed')
      })

    return () => abort.abort()
  }, [latitude, longitude, units, reloadKey])

  function retryExternal() {
    setExternalError(null)
    setReloadKey((key) => key + 1)
  }

  const forecastRaw = Array.isArray(weather?.attributes.forecast) ? weather?.attributes.forecast : []
  const forecast: ForecastEntry[] = forecastRaw
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const entry = item as Record<string, unknown>
      return {
        datetime: String(entry.datetime ?? ''),
        condition: String(entry.condition ?? 'unknown'),
        temperature: toNumber(entry.temperature),
        templow: toNumber(entry.templow),
        precipitation: toNumber(entry.precipitation),
        precipitation_probability: toNumber(entry.precipitation_probability),
        wind_speed: toNumber(entry.wind_speed),
      }
    })
    .filter((item): item is ForecastEntry => Boolean(item && item.datetime))
    .slice(0, 6)

  const currentCondition = String(weather?.state ?? 'unknown')
  const currentConditionLabel = conditionLabel(currentCondition)
  const currentTemp = externalData?.current.temperature ?? toNumber(outsideTemp?.state) ?? toNumber(weather?.attributes.temperature)
  const humidityValue = externalData?.current.humidity ?? toNumber(humidity?.state) ?? toNumber(weather?.attributes.humidity)
  const windValue = externalData?.current.windSpeed ?? toNumber(wind?.state) ?? toNumber(weather?.attributes.wind_speed)
  const uvNow = externalData?.current.uv ?? null
  const feelsLike = externalData?.current.apparentTemperature ?? null
  const gusts = externalData?.current.windGusts ?? null
  const precipitationNow = externalData?.current.precipitation ?? null
  // Today's actual chance from the external source first; the Home Assistant forecast attribute is
  // often absent, which is what left this reading blank.
  const externalRainChance = externalData?.daily?.[0]?.rainChance ?? null
  const rainChance = externalRainChance !== null
    ? Math.round(externalRainChance)
    : forecast.length
      ? Math.round(forecast.reduce((sum, day) => sum + (day.precipitation_probability ?? 0), 0) / forecast.length)
      : null

  const todaysExternal = externalData?.daily?.[0] ?? null
  const effectiveForecast = externalData?.daily?.length
    ? externalData.daily.slice(0, 6).map((day) => ({
      datetime: day.date,
      condition: day.condition,
      temperature: day.temperatureMax,
      templow: day.temperatureMin,
      precipitation: day.rainTotal,
      precipitation_probability: day.rainChance,
      wind_speed: null,
      uv_max: day.uvMax,
    }))
    : forecast.map((day) => ({ ...day, uv_max: null as number | null }))

  /**
   * The next 12 hourly slots, rolling past midnight rather than stopping at it. Anchoring to the
   * top of the current hour keeps the slot already in progress visible instead of skipping it.
   */
  const upcomingHours = useMemo(() => {
    if (!externalData?.hourly?.length) return []
    const hourStart = new Date()
    hourStart.setMinutes(0, 0, 0)
    return externalData.hourly
      .filter((slot) => {
        const slotTime = new Date(slot.time)
        return !Number.isNaN(slotTime.getTime()) && slotTime.getTime() >= hourStart.getTime()
      })
      .slice(0, 12)
  }, [externalData])

  const isoToday = todayIsoLocal()
  const nextRainSlot = upcomingHours.find((slot) => (slot.rainChance ?? 0) >= 35 || (slot.precipitation ?? 0) > 0)
  // Prefer the external condition (it is what the rest of this panel reports) and fall back to the
  // Home Assistant weather entity before the fetch lands.
  const heroTheme = skyTheme(externalData?.current.condition ?? currentCondition, new Date().getHours())

  /**
   * Everything the radar panel needs to stand in for itself on a dry day. Derived plainly rather
   * than memoized: it reads the wall clock, so a cached value would be the wrong kind of stable.
   */
  const radarOutlook = ((): RadarOutlook | undefined => {
    if (!externalData) return undefined
    const now = new Date().getTime()
    const nextDay = externalData.hourly.filter((slot) => {
      const at = new Date(slot.time).getTime()
      return !Number.isNaN(at) && at >= now && at <= now + 24 * 3_600_000
    })
    const peak = nextDay.reduce<ExternalHourly | null>(
      (best, slot) => ((slot.rainChance ?? 0) > (best?.rainChance ?? -1) ? slot : best),
      null,
    )
    const wetDay = externalData.daily.slice(1).find((day) => (day.rainChance ?? 0) >= 30)
    const aqi = Array.from(entities.values()).find((entity) => entity.attributes.device_class === 'aqi')

    return {
      peakRainChance: peak?.rainChance ?? null,
      peakRainHour: peak ? formatHour(peak.time) : null,
      nextWetDay: wetDay ? `${dayLabel(wetDay.date)} ${Math.round(wetDay.rainChance ?? 0)}%` : null,
      uvMax: externalData.daily[0]?.uvMax ?? null,
      windGusts: externalData.current.windGusts,
      sunrise: formatClock(externalData.daily[0]?.sunrise ?? null),
      sunset: formatClock(externalData.daily[0]?.sunset ?? null),
      airQuality: aqi ? `${aqi.state}` : null,
    }
  })()
  const sourceUpdatedAt = formatClock(externalData?.current.time ?? null)
  const hasCoordinates = latitude !== null && longitude !== null
  const externalPending = hasCoordinates && !externalData && !externalError
  const sourceMeta = externalData ? `Source: ${externalData.provider}` : null
  const onTabKey: (event: KeyboardEvent<HTMLElement>) => void = tabListKeyHandler(PANEL_INDEXES, slide, onSelectSlide)

  // Only an absent source is empty; a slow one is loading, and a failed one says so with a retry.
  function externalState(emptyTitle: string) {
    if (externalError) return <InlineError message={externalError} onRetry={retryExternal} />
    if (externalPending) return <LoadingState size="compact" label="Loading forecast" />
    if (!hasCoordinates) {
      return <EmptyState size="compact" title="No location for the forecast" hint="Looks for latitude and longitude on the weather.* entity or on zone.home" />
    }
    return <EmptyState size="compact" title={emptyTitle} />
  }

  if (entities.size > 0 && !weather && !outsideTemp && !hasCoordinates) {
    return (
      <section className="weather-view" aria-label="Weather forecast">
        <EmptyState
          icon={<CloudSun />}
          title="No weather source found"
          hint="Looks for a weather.* entity (for example weather.forecast_home) or zone.home coordinates for the external forecast"
        />
      </section>
    )
  }

  return (
    <section className="weather-view" aria-label="Weather forecast">
      <article className={`weather-hero sky-surface ${heroTheme.className}`}>
        <WeatherAtmosphere theme={heroTheme} />
        <div className="weather-current glass-strong">
          <p className="weather-eyebrow">Outside now</p>
          <div className="weather-current-main">
            <span className="weather-current-icon">{renderConditionIcon(currentCondition, 30)}</span>
            <div>
              <h2>{formatTemperature(currentTemp)}</h2>
              <p>{currentConditionLabel}</p>
            </div>
          </div>
          <div className="weather-today-band">
            <span>Today</span>
            <strong>{todaysExternal ? `${formatTemperature(todaysExternal.temperatureMax)} / ${formatTemperature(todaysExternal.temperatureMin)}` : '-- / --'}</strong>
            <small>{todaysExternal ? `UV max ${todaysExternal.uvMax === null ? '--' : todaysExternal.uvMax.toFixed(1)} · Rain ${todaysExternal.rainChance === null ? '--' : `${Math.round(todaysExternal.rainChance)}%`}` : 'Waiting for the forecast'}</small>
          </div>
        </div>
        <div className="weather-stat-grid">
          <div className="weather-stat-card glass-strong">
            <Droplets size={16} aria-hidden="true" />
            <strong>{humidityValue === null ? '--' : `${Math.round(humidityValue)}%`}</strong>
            <span>Humidity</span>
          </div>
          <div className="weather-stat-card glass-strong">
            <Wind size={16} aria-hidden="true" />
            <strong>{windValue === null ? '--' : `${Math.round(windValue)}`}</strong>
            <span>Wind</span>
          </div>
          <div className="weather-stat-card glass-strong">
            <Umbrella size={16} aria-hidden="true" />
            <strong>{rainChance === null ? '--' : `${rainChance}%`}</strong>
            <span>Rain chance</span>
          </div>
          <div className="weather-stat-card glass-strong">
            <Sun size={16} aria-hidden="true" />
            <strong>{uvNow === null ? '--' : uvNow.toFixed(1)}</strong>
            <span>UV now</span>
          </div>
        </div>
      </article>

      <section className="weather-panel-shell glass" role="tabpanel" id={TABPANEL_ID} aria-labelledby={tabId(slide)}>
        {slide === 0 && (
          <section className="weather-panel today-panel" aria-label="Today details">
            <header className="weather-panel-heading">
              <h3>Today at a glance</h3>
              {sourceMeta && <span>{sourceMeta}</span>}
            </header>
            {externalError && <InlineError message={externalError} onRetry={retryExternal} />}
            <div className="today-metric-grid">
              <article className="today-metric-card">
                <span>Feels like</span>
                <strong>{formatTemperature(feelsLike)}</strong>
              </article>
              <article className="today-metric-card">
                <span>Precip now</span>
                <strong>{precipitationNow === null ? '--' : `${precipitationNow.toFixed(2)} ${externalData?.precipitationUnit ?? 'mm'}`}</strong>
              </article>
              <article className="today-metric-card">
                <span>Wind gusts</span>
                <strong>{gusts === null ? '--' : `${Math.round(gusts)}`}</strong>
              </article>
              <article className="today-metric-card">
                <span>Sunrise</span>
                <strong>{formatClock(todaysExternal?.sunrise ?? null)}</strong>
                <small>Sunset {formatClock(todaysExternal?.sunset ?? null)}</small>
              </article>
            </div>
            <div className="now-detail-strip" aria-label="Current weather details">
              <span>{nextRainSlot ? `Next rain risk ${formatHour(nextRainSlot.time)} (${Math.round(nextRainSlot.rainChance ?? 0)}%)` : 'No significant rain expected soon'}</span>
              <span>{externalData?.timezone ? externalData.timezone : 'Local timezone'}</span>
              <span>Updated {sourceUpdatedAt}</span>
            </div>
          </section>
        )}

        {slide === 1 && (
          <section className="weather-panel hourly-strip" aria-label="Next 12 hours forecast">
            <header className="weather-panel-heading">
              <h3>Next 12 hours</h3>
              {sourceMeta && <span>{sourceMeta}</span>}
            </header>
            {upcomingHours.length === 0
              ? externalState('No hourly forecast from the source')
              : (
                <div className="hourly-grid">
                  {upcomingHours.map((slot) => {
                    const isTomorrow = localDayIso(slot.time) !== isoToday
                    return (
                      <article className={`hourly-card ${isTomorrow ? 'is-tomorrow' : ''}`} key={slot.time}>
                        <span>{formatHour(slot.time)}{isTomorrow ? ' +1' : ''}</span>
                        {renderConditionIcon(slot.condition, 18)}
                        <strong>{formatTemperature(slot.temperature)}</strong>
                        <small>UV {slot.uv === null ? '--' : slot.uv.toFixed(1)}</small>
                        <small>{slot.rainChance === null ? '--' : `${Math.round(slot.rainChance)}%`} rain</small>
                      </article>
                    )
                  })}
                </div>
              )}
          </section>
        )}

        {slide === 2 && (
          <section className="weather-panel" aria-label="6 day forecast">
            <header className="weather-panel-heading">
              <h3>Next 6 days</h3>
              <span>High/low, rain and UV outlook</span>
            </header>
            {effectiveForecast.length === 0
              ? externalState('No daily forecast yet')
              : (
                <section className="forecast-grid">
                  {effectiveForecast.map((day) => {
                    const rain = day.precipitation_probability
                    const rainAmount = day.precipitation
                    return (
                      <article className="forecast-card" key={`${day.datetime}-${day.condition}`}>
                        <header>
                          <strong>{dayLabel(day.datetime)}</strong>
                          <span>{conditionLabel(day.condition)}</span>
                        </header>
                        <span className="forecast-icon">{renderConditionIcon(day.condition, 24)}</span>
                        <div className="forecast-temp-row">
                          <strong>{formatTemperature(day.temperature)}</strong>
                          <small>{formatTemperature(day.templow)}</small>
                        </div>
                        <div className="forecast-meta">
                          <span>{rain === null ? '--' : `${Math.round(rain)}%`} rain</span>
                          <span>{rainAmount === null ? '--' : `${rainAmount.toFixed(2)} ${externalData?.precipitationUnit ?? 'mm'}`}</span>
                          <span>{day.uv_max === null ? 'UV --' : `UV ${day.uv_max.toFixed(1)}`}</span>
                        </div>
                      </article>
                    )
                  })}
                </section>
              )}
          </section>
        )}

        {slide === 3 && <RadarPanel latitude={latitude} longitude={longitude} outlook={radarOutlook} />}
      </section>

      <div className="weather-pager" role="tablist" aria-label="Weather panels" onKeyDown={onTabKey}>
        {PANELS.map((label, index) => {
          const selected = slide === index
          return (
            <button
              key={label}
              type="button"
              role="tab"
              id={tabId(index)}
              aria-selected={selected}
              aria-controls={TABPANEL_ID}
              tabIndex={selected ? 0 : -1}
              className={`glass-pill ${selected ? 'is-active' : ''}`}
              onClick={() => onSelectSlide(index)}
            >
              {label}
            </button>
          )
        })}
      </div>
    </section>
  )
}
