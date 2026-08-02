import { Clock3, Globe2, MapPin, MoonStar, Navigation, SunMedium, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import './WorldTimeMap.css'
import { worldCities } from './worldCities'

interface WorldTimeMapProps {
  now: Date
}

interface Location {
  id: string
  city: string
  country: string
  timeZone: string
  lat: number
  lon: number
  accent: string
  isHome?: boolean
}

/** A place currently being read, whether it came from a preset marker or a tap on the map. */
interface Reading {
  id: string
  city: string
  country: string
  timeZone: string
  accent: string
  x: number
  y: number
  /** Set when the tap landed far from any known city and the zone is a longitude estimate. */
  approximate?: boolean
  distanceKm?: number
}

const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago'
const satelliteMapUrl = 'https://eoimages.gsfc.nasa.gov/images/imagerecords/74000/74218/world.200412.3x5400x2700.jpg'
const pinAccent = '#7fd4ff'

// Jewel-tone accents drawn from the app's own palette (warn/accent/good, plus the violet
// already used for the Night Mode moment) rather than arbitrary neon hex, so the map reads
// as part of the same system instead of a generic map-pin widget.
const locations: Location[] = [
  { id: 'home', city: 'Home', country: 'Local time', timeZone: browserTimeZone, lat: 30.64, lon: -97.68, accent: 'var(--warn)', isHome: true },
  { id: 'frankfurt', city: 'Frankfurt', country: 'Germany', timeZone: 'Europe/Berlin', lat: 50.11, lon: 8.68, accent: 'var(--accent)' },
  { id: 'hyderabad', city: 'Hyderabad', country: 'India', timeZone: 'Asia/Kolkata', lat: 17.39, lon: 78.49, accent: 'var(--good)' },
  { id: 'auckland', city: 'Auckland', country: 'New Zealand', timeZone: 'Pacific/Auckland', lat: -36.85, lon: 174.76, accent: '#a99eff' },
]

/** The map is a plain equirectangular projection, so screen position and coordinates convert directly. */
function lonToX(lon: number) {
  return ((lon + 180) / 360) * 100
}

function latToY(lat: number) {
  return ((90 - lat) / 180) * 100
}

function xToLon(x: number) {
  return (x / 100) * 360 - 180
}

function yToLat(y: number) {
  return 90 - (y / 100) * 180
}

function distanceKm(fromLat: number, fromLon: number, toLat: number, toLon: number) {
  const toRadians = (value: number) => (value * Math.PI) / 180
  const deltaLat = toRadians(toLat - fromLat)
  const deltaLon = toRadians(toLon - fromLon)
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) * Math.sin(deltaLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Open ocean and polar taps have no nearby city, so fall back to the zone the sun keeps there. */
function solarZone(lon: number) {
  const offset = Math.max(-12, Math.min(12, Math.round(lon / 15)))
  return {
    // Etc/GMT zones invert the sign: Etc/GMT+5 is UTC-5.
    timeZone: `Etc/GMT${offset <= 0 ? '+' : '-'}${Math.abs(offset)}`,
    label: `UTC${offset === 0 ? '' : offset > 0 ? `+${offset}` : offset}`,
  }
}

function resolvePoint(x: number, y: number): Reading {
  const lat = yToLat(y)
  const lon = xToLon(x)
  let nearest = worldCities[0]
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const city of worldCities) {
    const candidate = distanceKm(lat, lon, city[3], city[4])
    if (candidate < nearestDistance) {
      nearestDistance = candidate
      nearest = city
    }
  }

  if (nearestDistance > 1500) {
    const zone = solarZone(lon)
    return {
      id: 'pin',
      city: zone.label,
      country: `Near ${nearest[0]} · ${Math.round(nearestDistance).toLocaleString()} km`,
      timeZone: zone.timeZone,
      accent: pinAccent,
      x,
      y,
      approximate: true,
      distanceKm: nearestDistance,
    }
  }

  return {
    id: 'pin',
    city: nearest[0],
    country: nearest[1],
    timeZone: nearest[2],
    accent: pinAccent,
    x,
    y,
    distanceKm: nearestDistance,
  }
}

function formatTime(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat([], { timeZone, hour: 'numeric', minute: '2-digit' }).format(date)
}

function formatDay(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat([], { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(date)
}

function getHour(date: Date, timeZone: string) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(date))
}

function getOffset(date: Date, timeZone: string) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(date)
    .find((item) => item.type === 'timeZoneName')
  return part?.value ?? timeZone.replaceAll('_', ' ')
}

/** Minutes a zone sits ahead of UTC at this instant, DST included. */
function zoneOffsetMinutes(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date)
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  const asUtc = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'))
  return Math.round((asUtc - date.getTime()) / 60_000)
}

function formatDifference(date: Date, timeZone: string) {
  const delta = zoneOffsetMinutes(date, timeZone) - zoneOffsetMinutes(date, browserTimeZone)
  if (delta === 0) return 'Same time as home'
  const hours = Math.floor(Math.abs(delta) / 60)
  const minutes = Math.abs(delta) % 60
  const span = `${hours ? `${hours}h` : ''}${hours && minutes ? ' ' : ''}${minutes ? `${minutes}m` : ''}`
  return `${span} ${delta > 0 ? 'ahead of' : 'behind'} home`
}

function daylightLabel(hour: number) {
  if (hour < 5 || hour >= 21) return 'Night'
  if (hour < 8) return 'Sunrise'
  if (hour < 18) return 'Daylight'
  return 'Evening'
}

export function WorldTimeMap({ now }: WorldTimeMapProps) {
  const [selectedId, setSelectedId] = useState('home')
  const [pin, setPin] = useState<Reading | null>(null)
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60
  const daylightCenter = ((24 - utcHour) / 24) * 100
  const zoneHours = useMemo(() => Array.from({ length: 24 }, (_, index) => (now.getUTCHours() - 12 + index + 24) % 24), [now])

  const presetReadings: Reading[] = locations.map((location) => ({
    id: location.id,
    city: location.city,
    country: location.country,
    timeZone: location.timeZone,
    accent: location.accent,
    x: lonToX(location.lon),
    y: latToY(location.lat),
  }))
  const readings = pin ? [...presetReadings, pin] : presetReadings
  const selected = readings.find((reading) => reading.id === selectedId) ?? readings[0]
  const selectedHour = getHour(now, selected.timeZone)

  /** Any point on the map is a valid reading, not just the four preset markers. */
  function readPoint(event: React.PointerEvent<HTMLButtonElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    const x = ((event.clientX - bounds.left) / bounds.width) * 100
    const y = ((event.clientY - bounds.top) / bounds.height) * 100
    setPin(resolvePoint(x, y))
    setSelectedId('pin')
  }

  function clearPin() {
    setPin(null)
    setSelectedId('home')
  }

  return (
    <section className="world-view" aria-labelledby="world-heading">
      <header className="world-heading">
        <div>
          <span className="eyebrow"><Navigation size={13} /> Global overview</span>
          <h2 id="world-heading">World time</h2>
          <p>Touch anywhere on the map — or a city marker — to read the time in that zone.</p>
        </div>
        <div className="world-selection" aria-live="polite">
          <span className="selection-icon" style={{ '--marker-color': selected.accent } as React.CSSProperties}>
            {selectedHour >= 7 && selectedHour < 19 ? <SunMedium size={20} /> : <MoonStar size={20} />}
          </span>
          <div className="selection-place">
            <span>{selected.approximate ? 'Estimated zone' : 'Selected location'}</span>
            <strong>{selected.city}</strong>
            <small>{selected.country}</small>
          </div>
          <div className="selection-time">
            <strong>{formatTime(now, selected.timeZone)}</strong>
            <small>{formatDay(now, selected.timeZone)}</small>
          </div>
          <p className="selection-meta">
            <Clock3 size={13} /> {daylightLabel(selectedHour)} · {getOffset(now, selected.timeZone)} · {formatDifference(now, selected.timeZone)}
          </p>
        </div>
      </header>

      <div className="world-body">
      <div className="world-map-shell">
        <div className="timezone-ruler" aria-hidden="true">
          {zoneHours.map((hour, index) => <span key={`${index}-${hour}`} className={hour === 12 ? 'is-noon' : hour === 0 ? 'is-midnight' : ''}>{hour === 0 ? '12a' : hour > 12 ? hour - 12 : hour}</span>)}
        </div>
        <div className="world-map" role="group" aria-label="Interactive satellite world time map">
          <svg viewBox="0 0 1000 500" preserveAspectRatio="none" role="img" aria-label="NASA satellite world map with day and night regions">
            <defs>
              <radialGradient id="nightShade" cx={`${daylightCenter}%`} cy="42%" r="56%">
                <stop offset="0" stopColor="#020611" stopOpacity="0" />
                <stop offset=".48" stopColor="#020611" stopOpacity=".04" />
                <stop offset=".78" stopColor="#01040d" stopOpacity=".58" />
                <stop offset="1" stopColor="#01030a" stopOpacity=".86" />
              </radialGradient>
              <linearGradient id="mapTint" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#06152b" stopOpacity=".08" />
                <stop offset="1" stopColor="#020715" stopOpacity=".32" />
              </linearGradient>
            </defs>
            <rect width="1000" height="500" className="map-ocean" />
            <image className="satellite-layer" href={satelliteMapUrl} x="0" y="0" width="1000" height="500" preserveAspectRatio="none" />
            <rect width="1000" height="500" fill="url(#mapTint)" />
            <rect width="1000" height="500" fill="url(#nightShade)" />
            <g className="map-grid">
              {Array.from({ length: 23 }, (_, index) => <line key={`v-${index}`} x1={(index + 1) * (1000 / 24)} x2={(index + 1) * (1000 / 24)} y1="0" y2="500" />)}
              {[125, 250, 375].map((y) => <line key={`h-${y}`} x1="0" x2="1000" y1={y} y2={y} />)}
            </g>
            <path className="route-line" d="M231 171 C360 75 455 101 524 136 S650 220 718 216 S880 275 971 362" />
          </svg>

          {/* Full-bleed hit target under the markers: the whole map is the control. */}
          <button
            className="map-surface"
            onPointerUp={readPoint}
            aria-label="Read the local time at a point on the map"
          />

          {presetReadings.map((reading) => {
            const active = reading.id === selected.id
            return (
              <button
                key={reading.id}
                className={`map-marker marker-${reading.id} ${active ? 'is-selected' : ''}`}
                style={{ left: `${reading.x}%`, top: `${reading.y}%`, '--marker-color': reading.accent } as React.CSSProperties}
                onPointerUp={(event) => { event.stopPropagation(); setSelectedId(reading.id) }}
                aria-pressed={active}
                aria-label={`${reading.city}, ${formatTime(now, reading.timeZone)}`}
              >
                <span className="marker-pulse" />
                <span className="marker-dot" />
                <span className="marker-label"><strong>{reading.city}</strong><small>{formatTime(now, reading.timeZone)}</small></span>
              </button>
            )
          })}

          {pin && (
            <div
              className={`map-pin ${pin.x > 62 ? 'flip-label' : ''}`}
              style={{ left: `${pin.x}%`, top: `${pin.y}%`, '--marker-color': pin.accent } as React.CSSProperties}
            >
              <span className="pin-rings" aria-hidden="true" />
              <MapPin size={22} aria-hidden="true" />
              <span className="pin-label">
                <strong>{formatTime(now, pin.timeZone)}</strong>
                <small>{pin.city}</small>
              </span>
            </div>
          )}

          <a className="map-credit" href="https://visibleearth.nasa.gov/images/74218/december-blue-marble-next-generation" target="_blank" rel="noreferrer">NASA Blue Marble</a>
          <div className="map-legend" aria-hidden="true"><span><SunMedium size={14} /> Day</span><span><MoonStar size={14} /> Night</span></div>
        </div>
      </div>

      <div className="world-clock-grid" role="list" aria-label="World clocks">
        {readings.map((reading) => {
          const hour = getHour(now, reading.timeZone)
          const active = reading.id === selected.id
          const isPin = reading.id === 'pin'
          return (
            <button
              key={reading.id}
              className={`world-clock-card ${active ? 'is-selected' : ''} ${isPin ? 'is-pinned' : ''}`}
              style={{ '--marker-color': reading.accent } as React.CSSProperties}
              onClick={() => setSelectedId(reading.id)}
              role="listitem"
              aria-pressed={active}
            >
              <span className="clock-card-icon">{isPin ? <Globe2 size={20} /> : hour >= 7 && hour < 19 ? <SunMedium size={20} /> : <MoonStar size={20} />}</span>
              <span className="clock-card-place"><strong>{reading.city}</strong><small>{reading.country}</small></span>
              <span className="clock-card-time"><strong>{formatTime(now, reading.timeZone)}</strong><small>{formatDay(now, reading.timeZone)}</small></span>
              <span className="clock-card-meta"><Clock3 size={13} /> {daylightLabel(hour)} · {getOffset(now, reading.timeZone)}</span>
              {isPin && <span className="clock-card-clear" role="button" tabIndex={0} aria-label="Clear the pinned point" onClick={(event) => { event.stopPropagation(); clearPin() }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); clearPin() } }}><X size={14} /></span>}
            </button>
          )
        })}
      </div>
      </div>
    </section>
  )
}
