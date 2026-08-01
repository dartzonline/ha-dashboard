import { Clock3, MapPin, MoonStar, Navigation, SunMedium } from 'lucide-react'
import { useMemo, useState } from 'react'
import './WorldTimeMap.css'

interface WorldTimeMapProps {
  now: Date
}

interface Location {
  id: string
  city: string
  country: string
  timeZone: string
  x: number
  y: number
  accent: string
  isHome?: boolean
}

const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago'
const satelliteMapUrl = 'https://eoimages.gsfc.nasa.gov/images/imagerecords/74000/74218/world.200412.3x5400x2700.jpg'

// Jewel-tone accents drawn from the app's own palette (warn/accent/good, plus the violet
// already used for the Night Mode moment) rather than arbitrary neon hex, so the map reads
// as part of the same system instead of a generic map-pin widget.
const locations: Location[] = [
  { id: 'home', city: 'Home', country: 'Local time', timeZone: browserTimeZone, x: 23.1, y: 34.2, accent: 'var(--warn)', isHome: true },
  { id: 'frankfurt', city: 'Frankfurt', country: 'Germany', timeZone: 'Europe/Berlin', x: 52.4, y: 27.1, accent: 'var(--accent)' },
  { id: 'hyderabad', city: 'Hyderabad', country: 'India', timeZone: 'Asia/Kolkata', x: 71.8, y: 43.1, accent: 'var(--good)' },
  { id: 'auckland', city: 'Auckland', country: 'New Zealand', timeZone: 'Pacific/Auckland', x: 97.1, y: 72.4, accent: '#a99eff' },
]

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

function daylightLabel(hour: number) {
  if (hour < 5 || hour >= 21) return 'Night'
  if (hour < 8) return 'Sunrise'
  if (hour < 18) return 'Daylight'
  return 'Evening'
}

export function WorldTimeMap({ now }: WorldTimeMapProps) {
  const [selectedId, setSelectedId] = useState('home')
  const selected = locations.find((location) => location.id === selectedId) ?? locations[0]
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60
  const daylightCenter = ((24 - utcHour) / 24) * 100
  const zoneHours = useMemo(() => Array.from({ length: 24 }, (_, index) => (now.getUTCHours() - 12 + index + 24) % 24), [now])

  return (
    <section className="world-view" aria-labelledby="world-heading">
      <header className="world-heading">
        <div>
          <span className="eyebrow"><Navigation size={13} /> Global overview</span>
          <h2 id="world-heading">World time</h2>
          <p>Select a city marker to compare local daylight and time zones.</p>
        </div>
        <div className="world-selection" aria-live="polite"><MapPin size={16} /><span>Selected location</span><strong>{selected.city}</strong></div>
      </header>

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

          {locations.map((location) => {
            const active = location.id === selected.id
            return (
              <button
                key={location.id}
                className={`map-marker marker-${location.id} ${active ? 'is-selected' : ''}`}
                style={{ left: `${location.x}%`, top: `${location.y}%`, '--marker-color': location.accent } as React.CSSProperties}
                onClick={() => setSelectedId(location.id)}
                aria-pressed={active}
                aria-label={`${location.city}, ${formatTime(now, location.timeZone)}`}
              >
                <span className="marker-pulse" />
                <span className="marker-dot" />
                <span className="marker-label"><strong>{location.city}</strong><small>{formatTime(now, location.timeZone)}</small></span>
              </button>
            )
          })}

          <a className="map-credit" href="https://visibleearth.nasa.gov/images/74218/december-blue-marble-next-generation" target="_blank" rel="noreferrer">NASA Blue Marble</a>
          <div className="map-legend" aria-hidden="true"><span><SunMedium size={14} /> Day</span><span><MoonStar size={14} /> Night</span></div>
        </div>
      </div>

      <div className="world-clock-grid" role="list" aria-label="World clocks">
        {locations.map((location) => {
          const hour = getHour(now, location.timeZone)
          const active = location.id === selected.id
          return (
            <button key={location.id} className={`world-clock-card ${active ? 'is-selected' : ''}`} onClick={() => setSelectedId(location.id)} role="listitem" aria-pressed={active}>
              <span className="clock-card-icon" style={{ '--marker-color': location.accent } as React.CSSProperties}>{hour >= 7 && hour < 19 ? <SunMedium size={20} /> : <MoonStar size={20} />}</span>
              <span className="clock-card-place"><strong>{location.city}</strong><small>{location.country}</small></span>
              <span className="clock-card-time"><strong>{formatTime(now, location.timeZone)}</strong><small>{formatDay(now, location.timeZone)}</small></span>
              <span className="clock-card-meta"><Clock3 size={13} /> {daylightLabel(hour)} · {getOffset(now, location.timeZone)}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
