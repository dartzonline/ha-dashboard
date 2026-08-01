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
import { apiUrl } from './api'
import type { HAEntity } from './types'
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

function dayIso(dateLike: string) {
  const date = new Date(dateLike)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
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

  useEffect(() => {
    if (latitude === null || longitude === null) return

    const abort = new AbortController()

    fetch(apiUrl(`weather/external?latitude=${latitude}&longitude=${longitude}`), { signal: abort.signal })
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
  }, [latitude, longitude])

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
  const currentConditionLabel = normalizeCondition(currentCondition).replace(/^./, (letter) => letter.toUpperCase())
  const currentTemp = externalData?.current.temperature ?? toNumber(outsideTemp?.state) ?? toNumber(weather?.attributes.temperature)
  const humidityValue = externalData?.current.humidity ?? toNumber(humidity?.state) ?? toNumber(weather?.attributes.humidity)
  const windValue = externalData?.current.windSpeed ?? toNumber(wind?.state) ?? toNumber(weather?.attributes.wind_speed)
  const uvNow = externalData?.current.uv ?? null
  const feelsLike = externalData?.current.apparentTemperature ?? null
  const gusts = externalData?.current.windGusts ?? null
  const precipitationNow = externalData?.current.precipitation ?? null
  const rainChance = forecast.length
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

  const remainingToday = useMemo(() => {
    if (!externalData?.hourly?.length) return []
    const now = new Date()
    const isoToday = todayIsoLocal()
    return externalData.hourly
      .filter((slot) => dayIso(slot.time) === isoToday)
      .filter((slot) => {
        const slotTime = new Date(slot.time)
        return !Number.isNaN(slotTime.getTime()) && slotTime.getTime() >= now.getTime()
      })
      .slice(0, 7)
  }, [externalData])

  const nextRainSlot = remainingToday.find((slot) => (slot.rainChance ?? 0) >= 35 || (slot.precipitation ?? 0) > 0)
  const sourceUpdatedAt = formatClock(externalData?.current.time ?? null)

  return (
    <section className="weather-view" aria-label="Weather forecast">
      <article className="weather-hero">
        <div className="weather-hero-atmosphere" aria-hidden="true">
          <span className="cloud cloud-one" />
          <span className="cloud cloud-two" />
          <span className="cloud cloud-three" />
          <span className="rain-line rain-one" />
          <span className="rain-line rain-two" />
          <span className="rain-line rain-three" />
        </div>
        <div className="weather-current">
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
            <small>{todaysExternal ? `UV max ${todaysExternal.uvMax === null ? '--' : todaysExternal.uvMax.toFixed(1)} · Rain ${todaysExternal.rainChance === null ? '--' : `${Math.round(todaysExternal.rainChance)}%`}` : 'Waiting for external details'}</small>
          </div>
        </div>
        <div className="weather-stat-grid">
          <div className="weather-stat-card">
            <Droplets size={16} />
            <strong>{humidityValue === null ? '--' : `${Math.round(humidityValue)}%`}</strong>
            <span>Humidity</span>
          </div>
          <div className="weather-stat-card">
            <Wind size={16} />
            <strong>{windValue === null ? '--' : `${Math.round(windValue)}`}</strong>
            <span>Wind</span>
          </div>
          <div className="weather-stat-card">
            <Umbrella size={16} />
            <strong>{rainChance === null ? '--' : `${rainChance}%`}</strong>
            <span>Rain chance</span>
          </div>
          <div className="weather-stat-card">
            <Sun size={16} />
            <strong>{uvNow === null ? '--' : uvNow.toFixed(1)}</strong>
            <span>UV now</span>
          </div>
        </div>
      </article>

      <section className="weather-panel-shell" aria-live="polite">
        {slide === 0 && (
          <section className="weather-panel today-panel" aria-label="Today details">
            <header className="weather-panel-heading">
              <strong>Today at a glance</strong>
              <span>{externalData ? `Source: ${externalData.provider}` : externalError ? 'Source unavailable' : 'Loading external source...'}</span>
            </header>
            {externalError && <p className="hourly-error">{externalError}</p>}
            <div className="today-metric-grid">
              <article className="today-metric-card tone-cool">
                <span>Feels like</span>
                <strong>{formatTemperature(feelsLike)}</strong>
              </article>
              <article className="today-metric-card tone-warm">
                <span>Precip now</span>
                <strong>{precipitationNow === null ? '--' : `${precipitationNow.toFixed(1)} mm`}</strong>
              </article>
              <article className="today-metric-card tone-breeze">
                <span>Wind gusts</span>
                <strong>{gusts === null ? '--' : `${Math.round(gusts)}`}</strong>
              </article>
              <article className="today-metric-card tone-daylight">
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
          <section className="weather-panel hourly-strip" aria-label="Remainder of today forecast">
            <div className="hourly-strip-title">
              <strong>Remainder of today</strong>
              <span>{externalData ? `Source: ${externalData.provider}` : externalError ? 'Source unavailable' : 'Loading external source...'}</span>
            </div>
            {externalError && <p className="hourly-error">{externalError}</p>}
            <div className="hourly-grid">
              {remainingToday.length === 0 && <p className="forecast-empty">Hourly forecast will appear when external data is available.</p>}
              {remainingToday.map((slot) => {
                return (
                  <article className="hourly-card" key={slot.time}>
                    <span>{formatHour(slot.time)}</span>
                    {renderConditionIcon(slot.condition, 18)}
                    <strong>{formatTemperature(slot.temperature)}</strong>
                    <small>UV {slot.uv === null ? '--' : slot.uv.toFixed(1)}</small>
                    <small>{slot.rainChance === null ? '--' : `${Math.round(slot.rainChance)}%`} rain</small>
                  </article>
                )
              })}
            </div>
          </section>
        )}

        {slide === 2 && (
          <section className="weather-panel" aria-label="6 day forecast">
            <header className="weather-panel-heading compact">
              <strong>Next 6 days</strong>
              <span>High/low, rain, and UV outlook</span>
            </header>
            <section className="forecast-grid">
              {effectiveForecast.length === 0 && <p className="forecast-empty">Waiting for weather forecast data.</p>}
              {effectiveForecast.map((day) => {
                const rain = day.precipitation_probability
                const rainAmount = day.precipitation
                return (
                  <article className="forecast-card" key={`${day.datetime}-${day.condition}`}>
                    <header>
                      <strong>{dayLabel(day.datetime)}</strong>
                      <span>{normalizeCondition(day.condition)}</span>
                    </header>
                    <span className="forecast-icon">{renderConditionIcon(day.condition, 24)}</span>
                    <div className="forecast-temp-row">
                      <strong>{formatTemperature(day.temperature)}</strong>
                      <small>{formatTemperature(day.templow)}</small>
                    </div>
                    <div className="forecast-meta">
                      <span>{rain === null ? '--' : `${Math.round(rain)}%`} rain</span>
                      <span>{rainAmount === null ? '--' : `${rainAmount.toFixed(1)} mm`}</span>
                      <span>{day.uv_max === null ? 'UV --' : `UV ${day.uv_max.toFixed(1)}`}</span>
                    </div>
                  </article>
                )
              })}
            </section>
          </section>
        )}
      </section>

      <div className="weather-pager" role="tablist" aria-label="Weather panels">
        {['Today', 'Hourly', '6-day'].map((label, index) => (
          <button
            key={label}
            role="tab"
            aria-selected={slide === index}
            className={slide === index ? 'is-active' : ''}
            onClick={() => onSelectSlide(index)}
            title={`Show ${label} panel`}
          >
            <span>{label}</span>
          </button>
        ))}
      </div>
    </section>
  )
}
