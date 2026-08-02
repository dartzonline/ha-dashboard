import { Cloud, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, Droplets, Sun, Sunrise, Sunset, Umbrella, Wind, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiUrl } from './api'
import { WeatherAtmosphere } from './WeatherAtmosphere'
import { skyTheme } from './weatherTheme'
import './CityWeatherPanel.css'

interface CityWeatherPanelProps {
  city: string
  country: string
  timeZone: string
  latitude: number
  longitude: number
  accent: string
  onClose: () => void
}

interface HourRow {
  time: string
  temperature: number | null
  rainChance: number | null
  condition: string
}

interface DayRow {
  date: string
  temperatureMax: number | null
  temperatureMin: number | null
  rainChance: number | null
  condition: string
  sunrise: string | null
  sunset: string | null
}

interface Payload {
  current: {
    temperature: number | null
    apparentTemperature: number | null
    humidity: number | null
    windSpeed: number | null
    condition: string
  }
  hourly: HourRow[]
  daily: DayRow[]
}

function conditionIcon(condition: string, size: number) {
  const value = condition.replaceAll('_', ' ').toLowerCase()
  if (/(lightning|thunder|storm)/.test(value)) return <CloudLightning size={size} />
  if (/(snow|sleet|hail|blizzard|flurr)/.test(value)) return <CloudSnow size={size} />
  if (/(rain|drizzle|shower|pour)/.test(value)) return <CloudRain size={size} />
  if (/(fog|mist|haze|rime)/.test(value)) return <CloudFog size={size} />
  if (/(partly|mainly|cloud|overcast)/.test(value)) return <CloudSun size={size} />
  if (/(clear|sunny)/.test(value)) return <Sun size={size} />
  return <Cloud size={size} />
}

function temperature(value: number | null) {
  return value === null ? '--' : `${Math.round(value)}°`
}

/**
 * The backend returns wall-clock strings for the *requested* location, so they are rendered
 * against that city's zone rather than the tablet's — 3 PM in Hyderabad must not read as 4:30 AM.
 */
function hourLabel(value: string) {
  const date = new Date(`${value}Z`)
  if (Number.isNaN(date.getTime())) return '--'
  return new Intl.DateTimeFormat([], { timeZone: 'UTC', hour: 'numeric' }).format(date)
}

function dayLabel(value: string) {
  const date = new Date(`${value}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return '--'
  return new Intl.DateTimeFormat([], { timeZone: 'UTC', weekday: 'short' }).format(date)
}

function clockLabel(value: string | null) {
  if (!value) return '--'
  const date = new Date(`${value}Z`)
  if (Number.isNaN(date.getTime())) return '--'
  return new Intl.DateTimeFormat([], { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(date)
}

export function CityWeatherPanel({ city, country, timeZone, latitude, longitude, accent, onClose }: CityWeatherPanelProps) {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  // No reset here: the caller keys this component by coordinates, so a different city mounts a fresh
  // instance rather than clearing state mid-effect.
  useEffect(() => {
    const abort = new AbortController()
    fetch(apiUrl(`weather/external?latitude=${latitude}&longitude=${longitude}`), { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Weather unavailable (${response.status})`)
        setData(await response.json())
      })
      .catch((cause: unknown) => {
        if ((cause as { name?: string }).name === 'AbortError') return
        setError(cause instanceof Error ? cause.message : 'Weather lookup failed')
      })
    return () => abort.abort()
  }, [latitude, longitude])

  // The upstream forecast starts at local midnight, so the slot matching this city's current hour
  // is where "next few hours" begins.
  const localHour = Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()))
  const hours = (data?.hourly ?? []).slice(localHour, localHour + 6)
  const days = (data?.daily ?? []).slice(0, 4)
  const today = data?.daily?.[0] ?? null
  // Themed from that city's own sky and its own clock, so 2 AM in Auckland looks like night here.
  const theme = skyTheme(data?.current.condition ?? 'cloudy', localHour)

  return (
    <div className="city-weather-backdrop" role="presentation" onClick={onClose}>
      <section
        className={`city-weather-sheet sky-surface ${theme.className}`}
        role="dialog"
        aria-modal="true"
        aria-label={`Weather in ${city}`}
        style={{ '--marker-color': accent } as React.CSSProperties}
        onClick={(event) => event.stopPropagation()}
      >
        {data && <WeatherAtmosphere theme={theme} />}
        <header>
          <div>
            <span>Weather now</span>
            <h2>{city}</h2>
            <small>{country}</small>
          </div>
          <button onClick={onClose} title="Close city weather" aria-label="Close city weather"><X size={20} /></button>
        </header>

        {error && <p className="city-weather-error">{error}</p>}
        {!data && !error && <p className="city-weather-loading">Loading {city} forecast…</p>}

        {data && (
          <>
            <div className="city-weather-now">
              <span className="city-weather-icon">{conditionIcon(data.current.condition, 40)}</span>
              <strong>{temperature(data.current.temperature)}</strong>
              <div>
                <p>{data.current.condition.replace(/^./, (letter) => letter.toUpperCase())}</p>
                <small>Feels like {temperature(data.current.apparentTemperature)}</small>
              </div>
            </div>

            <div className="city-weather-stats">
              <div><Droplets size={15} /><strong>{data.current.humidity === null ? '--' : `${Math.round(data.current.humidity)}%`}</strong><span>Humidity</span></div>
              <div><Wind size={15} /><strong>{data.current.windSpeed === null ? '--' : Math.round(data.current.windSpeed)}</strong><span>Wind</span></div>
              <div><Umbrella size={15} /><strong>{today?.rainChance == null ? '--' : `${Math.round(today.rainChance)}%`}</strong><span>Rain today</span></div>
              <div><Sunrise size={15} /><strong>{clockLabel(today?.sunrise ?? null)}</strong><span>Sunrise</span></div>
              <div><Sunset size={15} /><strong>{clockLabel(today?.sunset ?? null)}</strong><span>Sunset</span></div>
            </div>

            <h3>Next hours</h3>
            <div className="city-weather-hours">
              {hours.length === 0 && <p className="city-weather-loading">No hourly detail available.</p>}
              {hours.map((hour) => (
                <article key={hour.time}>
                  <span>{hourLabel(hour.time)}</span>
                  {conditionIcon(hour.condition, 17)}
                  <strong>{temperature(hour.temperature)}</strong>
                  <small>{hour.rainChance === null ? '--' : `${Math.round(hour.rainChance)}%`}</small>
                </article>
              ))}
            </div>

            <h3>Next days</h3>
            <div className="city-weather-days">
              {days.map((day) => (
                <article key={day.date}>
                  <span>{dayLabel(day.date)}</span>
                  {conditionIcon(day.condition, 17)}
                  <strong>{temperature(day.temperatureMax)}</strong>
                  <small>{temperature(day.temperatureMin)}</small>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  )
}
