import { useEffect, useMemo, useState } from 'react'
import { Plane, PlaneTakeoff, Radar as RadarIcon, Search, X } from 'lucide-react'
import { apiUrl } from './api'
import type { HAEntity } from './types'
import './FlightsView.css'

interface Aircraft {
  icao24: string
  callsign: string
  airline: string | null
  airlineCode: string | null
  type: string | null
  reg: string | null
  kind: 'jet' | 'heavy' | 'bizjet' | 'turboprop' | 'light' | 'heli'
  fromCode: string | null
  fromCity: string | null
  fromCountry: string | null
  toCode: string | null
  toCity: string | null
  toCountry: string | null
  altitudeFt: number | null
  speedKt: number | null
  verticalRateFpm: number | null
  onGround: boolean
  trackDeg: number | null
  bearingDeg: number | null
  distanceKm: number | null
  lat: number
  lon: number
}

interface NearbyResponse {
  home: { lat: number; lon: number; rangeKm: number }
  updatedAt: string
  aircraft: Aircraft[]
}

interface TrackSchedule {
  depScheduled?: string
  depActual?: string
  arrScheduled?: string
  arrEstimated?: string
  delayMin?: number
  status?: string
}

interface TrackRoute {
  fromCode: string
  fromCity: string
  toCode: string
  toCity: string
}

interface TrackResponse {
  query: string | null
  mode: 'track' | 'landed' | 'await' | null
  flight: Aircraft | null
  route: TrackRoute | null
  schedule: TrackSchedule
  progress: number
  etaLine: string | null
}

interface FlightsViewProps {
  entities: Map<string, HAEntity>
  slide: number
  onSelectSlide: (index: number) => void
}

type Phase = 'climb' | 'cruise' | 'descend' | 'ground'

const LOGO_SOURCES = [
  (code: string) => `https://raw.githubusercontent.com/Jxck-S/airline-logos/main/custom_logos/${code}.png`,
  (code: string) => `https://raw.githubusercontent.com/Jxck-S/airline-logos/main/radarbox_logos/${code}.png`,
  (code: string) => `https://raw.githubusercontent.com/Jxck-S/airline-logos/main/flightaware_logos/${code}.png`,
]

const RADAR_SIZE = 220
const RADAR_CENTER = RADAR_SIZE / 2
const RADAR_RADIUS = 92
const RING_COUNT = 3
const TICK_COUNT = 12

// Real-map backdrop behind the radar overlay: free, keyless CARTO dark tiles (the same
// source FlyInk-Board's own web dashboard used for its radar map), positioned by ordinary
// slippy-map tile math and sized to roughly match the currently plotted range.
const MAP_GRID = 5
const MAP_ZOOM_MIN = 4
const MAP_ZOOM_MAX = 10

function lonToTileX(lon: number, zoom: number) {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom)
}

function latToTileY(lat: number, zoom: number) {
  const rad = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** zoom)
}

/** Zoom level whose 5x5 tile grid roughly spans 2x the given range. */
function zoomForRangeKm(rangeKm: number) {
  const raw = Math.round(Math.log2((MAP_GRID / 2) * 40_075 / Math.max(rangeKm, 1)))
  return Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, raw))
}

function toNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function fromAttributesNumber(entity: HAEntity | undefined, key: string) {
  return toNumber(entity?.attributes[key])
}

function formatNumber(value: number, maximumFractionDigits = 0) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value)
}

function formatClock(value: string | undefined | null) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function phaseOf(aircraft: Aircraft): Phase {
  if (aircraft.onGround) return 'ground'
  if (aircraft.verticalRateFpm !== null && aircraft.verticalRateFpm > 100) return 'climb'
  if (aircraft.verticalRateFpm !== null && aircraft.verticalRateFpm < -100) return 'descend'
  return 'cruise'
}

function phaseLabel(phase: Phase) {
  if (phase === 'climb') return 'Climb'
  if (phase === 'descend') return 'Descend'
  if (phase === 'ground') return 'Ground'
  return 'Cruise'
}

function modeLabel(mode: TrackResponse['mode']) {
  if (mode === 'track') return 'En Route'
  if (mode === 'landed') return 'Landed'
  if (mode === 'await') return 'Awaiting'
  return 'Unknown'
}

function modeTone(mode: TrackResponse['mode']): 'good' | 'accent' | 'muted' {
  if (mode === 'track') return 'good'
  if (mode === 'landed') return 'accent'
  return 'muted'
}

/** Polar placement for a radar blip: bearing rotates clockwise from north, distance is normalized against the home range so the furthest traffic sits just inside the outer ring. */
function polarPoint(bearingDeg: number, distanceKm: number | null, rangeKm: number) {
  const ratio = distanceKm === null ? 1 : Math.min(Math.max(distanceKm / rangeKm, 0), 1)
  const radius = 10 + ratio * (RADAR_RADIUS - 10)
  const rad = (bearingDeg * Math.PI) / 180
  return {
    x: RADAR_CENTER + Math.sin(rad) * radius,
    y: RADAR_CENTER - Math.cos(rad) * radius,
  }
}

function AirlineLogo({ code }: { code: string | null }) {
  // Reset the attempt counter when the airline code changes by adjusting state during render
  // (the React-recommended alternative to an effect that only mirrors a prop).
  const [state, setState] = useState({ code, attempt: 0 })
  if (state.code !== code) {
    setState({ code, attempt: 0 })
  }

  const initials = code ? code.slice(0, 2).toUpperCase() : '–'

  if (!code || state.attempt >= LOGO_SOURCES.length) {
    return <span className="airline-logo airline-logo-fallback" aria-hidden="true">{initials}</span>
  }

  return (
    <img
      className="airline-logo"
      src={LOGO_SOURCES[state.attempt](code)}
      alt=""
      aria-hidden="true"
      onError={() => setState((current) => ({ ...current, attempt: current.attempt + 1 }))}
    />
  )
}

function DelayBadge({ delayMin }: { delayMin: number | undefined }) {
  if (delayMin === undefined) return <span className="delay-badge tone-muted">--</span>
  if (delayMin >= 5) return <span className="delay-badge tone-danger">{`+${formatNumber(delayMin)} MIN`}</span>
  if (delayMin <= -2) return <span className="delay-badge tone-good">{`${formatNumber(Math.abs(delayMin))} MIN EARLY`}</span>
  return <span className="delay-badge tone-neutral">On time</span>
}

export function FlightsView({ entities, slide, onSelectSlide }: FlightsViewProps) {
  const [nearby, setNearby] = useState<NearbyResponse | null>(null)
  const [nearbyError, setNearbyError] = useState<string | null>(null)
  const [hoveredCallsign, setHoveredCallsign] = useState<string | null>(null)
  const [trackNotice, setTrackNotice] = useState<string | null>(null)

  const [track, setTrack] = useState<TrackResponse | null>(null)
  const [queryInput, setQueryInput] = useState('')
  const [trackBusy, setTrackBusy] = useState(false)

  const weather = entities.get('weather.forecast_home') ?? Array.from(entities.values()).find((entity) => entity.entity_id.startsWith('weather.'))
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
    let cancelled = false

    function loadNearby() {
      fetch(apiUrl(`flights/nearby?latitude=${latitude}&longitude=${longitude}&limit=15`))
        .then(async (response) => {
          if (!response.ok) throw new Error(`Flight radar unavailable (${response.status})`)
          const payload: NearbyResponse = await response.json()
          if (cancelled) return
          setNearby(payload)
          setNearbyError(null)
        })
        .catch((error: unknown) => {
          if (cancelled) return
          setNearbyError(error instanceof Error ? error.message : 'Flight radar failed')
        })
    }

    loadNearby()
    const timer = window.setInterval(loadNearby, 15_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [latitude, longitude])

  useEffect(() => {
    let cancelled = false

    function loadTrack() {
      fetch(apiUrl('flights/track'))
        .then(async (response) => {
          if (!response.ok) throw new Error(`Track unavailable (${response.status})`)
          const payload: TrackResponse = await response.json()
          if (!cancelled) setTrack(payload)
        })
        .catch(() => {
          // Keep the last known tracked flight on screen; the next poll will retry.
        })
    }

    loadTrack()
    const timer = window.setInterval(loadTrack, 10_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  async function trackFlight(query: string) {
    const trimmed = query.trim()
    if (!trimmed) return
    setTrackBusy(true)
    try {
      const response = await fetch(apiUrl('flights/track'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed }),
      })
      if (response.ok) {
        const payload: TrackResponse = await response.json()
        setTrack(payload)
        setTrackNotice(`Tracking ${trimmed}`)
        window.setTimeout(() => setTrackNotice(null), 4000)
      }
    } catch {
      // Network hiccup; the 10s poll picks it back up.
    } finally {
      setTrackBusy(false)
    }
  }

  async function stopTracking() {
    setTrackBusy(true)
    try {
      await fetch(apiUrl('flights/track'), { method: 'DELETE' })
      setTrack(null)
    } catch {
      // Network hiccup; the 10s poll reconciles state.
    } finally {
      setTrackBusy(false)
    }
  }

  const rangeKm = nearby?.home.rangeKm ?? 100
  const aircraftSorted = [...(nearby?.aircraft ?? [])].sort((left, right) => (left.distanceKm ?? Infinity) - (right.distanceKm ?? Infinity))

  const mapZoom = zoomForRangeKm(rangeKm)
  const mapTiles = useMemo(() => {
    if (latitude === null || longitude === null) return []
    const centerX = lonToTileX(longitude, mapZoom)
    const centerY = latToTileY(latitude, mapZoom)
    const edge = Math.floor(MAP_GRID / 2)
    return Array.from({ length: MAP_GRID * MAP_GRID }, (_, index) => {
      const row = Math.floor(index / MAP_GRID)
      const col = index % MAP_GRID
      return { key: `${row}-${col}`, x: centerX - edge + col, y: centerY - edge + row }
    })
  }, [latitude, longitude, mapZoom])

  const ringRadii = Array.from({ length: RING_COUNT }, (_, index) => (RADAR_RADIUS / RING_COUNT) * (index + 1))
  const ticks = Array.from({ length: TICK_COUNT }, (_, index) => index * (360 / TICK_COUNT))
  const compassLabels: { label: string; deg: number }[] = [
    { label: 'N', deg: 0 },
    { label: 'E', deg: 90 },
    { label: 'S', deg: 180 },
    { label: 'W', deg: 270 },
  ]

  const progressPct = Math.round(Math.min(Math.max(track?.progress ?? 0, 0), 1) * 100)
  const schedule = track?.schedule ?? {}
  const isPinned = Boolean(track && track.query && track.mode)

  return (
    <section className="flights-view" aria-label="Flight tracker">
      <div className="flights-panel-shell" aria-live="polite">
        {slide === 0 && (
          <section className="flights-panel radar-panel" aria-label="Nearby aircraft radar">
            <div className="radar-column">
              <div className="radar-scope">
                {mapTiles.length > 0 && (
                  <div className="radar-map" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${MAP_GRID}, 1fr)`, gridTemplateRows: `repeat(${MAP_GRID}, 1fr)` }}>
                    {mapTiles.map((tile) => (
                      <img key={tile.key} src={`https://a.basemaps.cartocdn.com/dark_nolabels/${mapZoom}/${tile.x}/${tile.y}.png`} alt="" loading="eager" />
                    ))}
                  </div>
                )}
                <svg className="radar-svg" viewBox={`0 0 ${RADAR_SIZE} ${RADAR_SIZE}`} role="img" aria-label="Radar showing nearby aircraft by bearing, distance, and approximate map position">
                  {ringRadii.map((radius) => (
                    <circle key={radius} className="radar-ring" cx={RADAR_CENTER} cy={RADAR_CENTER} r={radius} />
                  ))}
                  {ticks.map((deg) => {
                    const outer = polarPoint(deg, rangeKm, rangeKm)
                    const inner = polarPoint(deg, rangeKm * 0.92, rangeKm)
                    return <line key={deg} className="radar-tick" x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} />
                  })}
                  {compassLabels.map(({ label, deg }) => {
                    const point = polarPoint(deg, rangeKm, rangeKm)
                    const labelPoint = {
                      x: RADAR_CENTER + (point.x - RADAR_CENTER) * 1.12,
                      y: RADAR_CENTER + (point.y - RADAR_CENTER) * 1.12,
                    }
                    return (
                      <text key={label} className="radar-compass-label" x={labelPoint.x} y={labelPoint.y} textAnchor="middle" dominantBaseline="middle">
                        {label}
                      </text>
                    )
                  })}
                  <circle className="radar-home-glow" cx={RADAR_CENTER} cy={RADAR_CENTER} r={7} />
                  <circle className="radar-home" cx={RADAR_CENTER} cy={RADAR_CENTER} r={3.2} />
                  {aircraftSorted.map((aircraft) => {
                    if (aircraft.bearingDeg === null) return null
                    const point = polarPoint(aircraft.bearingDeg, aircraft.distanceKm, rangeKm)
                    const phase = phaseOf(aircraft)
                    const heading = aircraft.trackDeg ?? aircraft.bearingDeg
                    const isActive = hoveredCallsign === aircraft.callsign
                    return (
                      <g
                        key={aircraft.icao24}
                        className={`radar-blip tone-${phase} ${isActive ? 'is-active' : ''}`}
                        transform={`translate(${point.x} ${point.y}) rotate(${heading})`}
                        role="button"
                        tabIndex={0}
                        aria-label={`${aircraft.callsign}, ${phaseLabel(phase)}`}
                        onClick={() => setHoveredCallsign((current) => (current === aircraft.callsign ? null : aircraft.callsign))}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            setHoveredCallsign((current) => (current === aircraft.callsign ? null : aircraft.callsign))
                          }
                        }}
                      >
                        <circle className="radar-blip-halo" r={9} />
                        <path className="radar-blip-glyph" d="M0,-6.5 L3.6,5.4 L0,3 L-3.6,5.4 Z" />
                      </g>
                    )
                  })}
                </svg>
                <div className="radar-sweep" aria-hidden="true" />
              </div>
              <p className="radar-meta">
                {nearbyError ? nearbyError : nearby ? `${aircraftSorted.length} tracked within ${formatNumber(rangeKm)} km` : 'Loading nearby traffic…'}
              </p>
            </div>

            <div className="flights-list-column">
              <header className="flights-list-heading">
                <span><RadarIcon size={16} /></span>
                <div><strong>Nearby traffic</strong><p>Tap a row to track it</p></div>
              </header>
              {trackNotice && <p className="flights-list-notice">{trackNotice}</p>}
              <div className="flights-list">
                {aircraftSorted.length === 0 && (
                  <p className="flights-list-empty">{nearbyError ? 'Radar feed unavailable right now.' : 'No aircraft in range.'}</p>
                )}
                {aircraftSorted.map((aircraft) => {
                  const phase = phaseOf(aircraft)
                  const isActive = hoveredCallsign === aircraft.callsign
                  return (
                    <button
                      key={aircraft.icao24}
                      className={`flight-row ${isActive ? 'is-highlighted' : ''}`}
                      onClick={() => trackFlight(aircraft.callsign)}
                      title={`Track ${aircraft.callsign}`}
                    >
                      <AirlineLogo code={aircraft.airlineCode} />
                      <div className="flight-row-main">
                        <strong>{aircraft.callsign}</strong>
                        <span>{aircraft.airline ?? 'General aviation'}{aircraft.type ? ` · ${aircraft.type}` : ''}</span>
                        <span className="flight-route">
                          {aircraft.fromCode && aircraft.toCode ? `${aircraft.fromCode} → ${aircraft.toCode}` : '—'}
                        </span>
                      </div>
                      <div className="flight-row-metrics">
                        <span>{aircraft.altitudeFt !== null ? `${formatNumber(aircraft.altitudeFt)} ft` : '—'}</span>
                        <span>{aircraft.speedKt !== null ? `${formatNumber(aircraft.speedKt)} kt` : '—'}</span>
                        <span>{aircraft.distanceKm !== null ? `${aircraft.distanceKm.toFixed(1)} km` : '—'}</span>
                      </div>
                      <span className={`phase-chip tone-${phase}`}><i />{phaseLabel(phase)}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </section>
        )}

        {slide === 1 && (
          <section className="flights-panel track-panel" aria-label="Track a flight">
            <form
              className="track-form"
              onSubmit={(event) => {
                event.preventDefault()
                trackFlight(queryInput)
              }}
            >
              <div className="track-input-wrap">
                <Search size={15} />
                <input
                  type="text"
                  value={queryInput}
                  onChange={(event) => setQueryInput(event.target.value.toUpperCase())}
                  placeholder="AA1234 · DL456 · DAL789"
                  style={{ textTransform: 'uppercase' }}
                  aria-label="Flight number"
                />
              </div>
              <button type="submit" className="track-action track-action-go" disabled={!queryInput.trim() || trackBusy}>Track</button>
              <button type="button" className="track-action track-action-stop" onClick={stopTracking} disabled={!isPinned || trackBusy}>
                <X size={14} />Stop
              </button>
            </form>

            {!isPinned || !track ? (
              <div className="track-empty">
                <PlaneTakeoff size={28} />
                <p>No flight pinned. Track one from the Radar page or type a flight number above.</p>
              </div>
            ) : (
              <div className="track-card">
                <div className={`track-mode tone-${modeTone(track.mode)}`}>{modeLabel(track.mode)}</div>

                {track.route && (
                  <div className="track-route">
                    <div className="track-route-end">
                      <strong>{track.route.fromCode}</strong>
                      <span>{track.route.fromCity}</span>
                    </div>
                    <span className="track-route-arrow"><Plane size={16} /></span>
                    <div className="track-route-end">
                      <strong>{track.route.toCode}</strong>
                      <span>{track.route.toCity}</span>
                    </div>
                  </div>
                )}

                <div className="track-progress">
                  <div className="track-progress-track">
                    <div className="track-progress-fill" style={{ width: `${progressPct}%` }} />
                    <span className="track-progress-plane" style={{ left: `${progressPct}%` }}><Plane size={13} /></span>
                  </div>
                </div>

                <div className="track-schedule">
                  <div className="track-schedule-col">
                    <span>Departure</span>
                    <strong>{formatClock(schedule.depActual ?? schedule.depScheduled)}</strong>
                    {schedule.depScheduled && <small>Sched {formatClock(schedule.depScheduled)}</small>}
                  </div>
                  <div className="track-schedule-col">
                    <span>Arrival</span>
                    <strong>{formatClock(schedule.arrEstimated ?? schedule.arrScheduled)}</strong>
                    {schedule.arrScheduled && <small>Sched {formatClock(schedule.arrScheduled)}</small>}
                  </div>
                  <div className="track-schedule-col">
                    <span>Status</span>
                    <DelayBadge delayMin={schedule.delayMin} />
                  </div>
                </div>

                {track.etaLine && <p className="track-eta">{track.etaLine}</p>}

                {track.flight && (
                  <div className="track-telemetry">
                    <div><span>Altitude</span><strong>{track.flight.altitudeFt !== null ? `${formatNumber(track.flight.altitudeFt)} ft` : '—'}</strong></div>
                    <div><span>Speed</span><strong>{track.flight.speedKt !== null ? `${formatNumber(track.flight.speedKt)} kt` : '—'}</strong></div>
                    <div><span>Heading</span><strong>{track.flight.trackDeg !== null ? `${Math.round(track.flight.trackDeg)}°` : '—'}</strong></div>
                    <div><span>Distance</span><strong>{track.flight.distanceKm !== null ? `${track.flight.distanceKm.toFixed(1)} km` : '—'}</strong></div>
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </div>

      <div className="flights-pager" role="tablist" aria-label="Flights panels">
        {['Radar', 'Track'].map((label, index) => (
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
