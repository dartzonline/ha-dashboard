import { useEffect, useMemo, useRef, useState } from 'react'
import { Info, MapPinOff, Map as MapIcon, Plane, PlaneTakeoff, Plus, Radar as RadarIcon, Search, X } from 'lucide-react'
import { AirlineLogo } from './AirlineLogo'
import { ShowcaseAircraft, type ShowcaseAircraftType } from './aircraftSilhouettes'
import { AllRoutesMap } from './AllRoutesMap'
import { apiUrl } from './api'
import { etaLabel } from './flightBadge'
import { RouteMap } from './RouteMap'
import type { HAEntity } from './types'
import { tabListKeyHandler } from './tablist'
import { publishTrack, refreshFlightBoard, useFlightBoard } from './useFlightBoard'
import type { Aircraft, TrackEntry, TrackResponse } from './useFlightBoard'
import { homeCoordinates } from './useServiceStatus'
import { EmptyState, InlineError, LoadingState } from './ui/StateMessages'
import './FlightsView.css'

interface FlightsViewProps {
  entities: Map<string, HAEntity>
  slide: number
  onSelectSlide: (index: number) => void
}

type Phase = 'climb' | 'cruise' | 'descend' | 'ground'

const RADAR_SIZE = 220
const RADAR_CENTER = RADAR_SIZE / 2
const RADAR_RADIUS = 92
const RING_COUNT = 3
const TICK_COUNT = 12

// Matches the backend pin cap: pinning beyond this evicts the oldest.
const MAX_TRACKED = 6
/** Rows on the radar list; the shared poller fetches more so the header can find an airliner among them. */
const NEARBY_ROWS = 15

// Real-map backdrop behind the radar overlay: free, keyless CARTO dark tiles (the same
// source FlyInk-Board's own web dashboard used for its radar map), positioned by ordinary
// slippy-map tile math. Fixed at a legible local-street zoom rather than derived from the
// (much larger) search radius — matching the radar's exact range would zoom the map out
// to the point of showing almost no recognizable detail.
const MAP_GRID = 5
const MAP_ZOOM = 12

function lonToTileX(lon: number, zoom: number) {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom)
}

function latToTileY(lat: number, zoom: number) {
  const rad = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** zoom)
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

function shortModeLabel(mode: TrackResponse['mode']) {
  if (mode === 'track') return 'En route'
  if (mode === 'landed') return 'Landed'
  if (mode === 'await') return 'Waiting'
  return '—'
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

function DelayBadge({ delayMin }: { delayMin: number | null | undefined }) {
  if (delayMin === undefined || delayMin === null) return <span className="delay-badge tone-muted">--</span>
  if (delayMin >= 5) return <span className="delay-badge tone-danger">{`+${formatNumber(delayMin)} MIN`}</span>
  if (delayMin <= -2) return <span className="delay-badge tone-good">{`${formatNumber(Math.abs(delayMin))} MIN EARLY`}</span>
  return <span className="delay-badge tone-neutral">On time</span>
}

const SHOWCASE: {
  code: string
  name: string
  tag: string
  type: ShowcaseAircraftType
  span: string
  cruise: string
  range: string
}[] = [
  { code: '747', name: 'Boeing 747-8', tag: 'Queen of the skies', type: 'b747', span: '68.4 m', cruise: 'Mach 0.855', range: '14 320 km' },
  { code: 'A380', name: 'Airbus A380-800', tag: 'Superjumbo', type: 'a380', span: '79.8 m', cruise: 'Mach 0.85', range: '14 800 km' },
  { code: '777', name: 'Boeing 777-300ER', tag: 'Triple seven', type: 'b777', span: '64.8 m', cruise: 'Mach 0.84', range: '13 650 km' },
  { code: '787', name: 'Boeing 787-9', tag: 'Dreamliner', type: 'b787', span: '60.1 m', cruise: 'Mach 0.85', range: '14 140 km' },
  { code: 'MD11', name: 'McDonnell Douglas MD-11', tag: 'Last of the trijets', type: 'md11', span: '51.7 m', cruise: 'Mach 0.82', range: '12 670 km' },
  { code: 'A330', name: 'Airbus A330-900neo', tag: 'Long-haul workhorse', type: 'a330', span: '64.0 m', cruise: 'Mach 0.82', range: '13 330 km' },
  { code: '767', name: 'Boeing 767-300ER', tag: 'Transatlantic original', type: 'b767', span: '47.6 m', cruise: 'Mach 0.80', range: '11 070 km' },
  { code: 'A340', name: 'Airbus A340-600', tag: 'Longest Airbus', type: 'a340', span: '63.4 m', cruise: 'Mach 0.83', range: '14 450 km' },
]

/** Fills the idle top half of the Track page so it reads as a display, not an empty form. */
function TrackShowcase() {
  const [index, setIndex] = useState(0)
  const swipeStart = useRef<{ x: number; y: number } | null>(null)

  function move(delta: number) {
    setIndex((value) => (value + delta + SHOWCASE.length) % SHOWCASE.length)
  }

  useEffect(() => {
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % SHOWCASE.length), 6000)
    return () => window.clearInterval(timer)
  }, [])

  const jet = SHOWCASE[index]

  // Pointer events carry the gesture so a mouse drag works as well as a finger. Every event this
  // pane handles stops at the pane, touch included: App's page swipe listens for touch as well as
  // pointer events, and a drag through the jets must not also turn the page.
  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.stopPropagation()
    swipeStart.current = { x: event.clientX, y: event.clientY }
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    event.stopPropagation()
    if (!swipeStart.current) return
    const deltaX = event.clientX - swipeStart.current.x
    const deltaY = event.clientY - swipeStart.current.y
    swipeStart.current = null
    if (Math.abs(deltaX) < 42 || Math.abs(deltaX) < Math.abs(deltaY) * 1.15) return
    move(deltaX < 0 ? 1 : -1)
  }

  function stopTouch(event: React.TouchEvent<HTMLDivElement>) {
    event.stopPropagation()
  }

  return (
    <div
      className="track-showcase"
      aria-hidden="true"
      data-swipe-ignore
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={(event) => { event.stopPropagation(); swipeStart.current = null }}
      onTouchStart={stopTouch}
      onTouchEnd={stopTouch}
      onTouchCancel={stopTouch}
    >
      <div className="showcase-stage">
        <span className="showcase-ring showcase-ring-a" />
        <span className="showcase-ring showcase-ring-b" />
        <span className="showcase-ring showcase-ring-c" />
        <span className="showcase-sweep" />
        <span className="showcase-orbit"><i /></span>
        <span className="showcase-contrail showcase-contrail-a" />
        <span className="showcase-contrail showcase-contrail-b" />
        <ShowcaseAircraft key={jet.code} type={jet.type} className="showcase-plane" />
      </div>
      <div className="showcase-caption">
        <span className="showcase-code">{jet.code}</span>
        <strong>{jet.name}</strong>
        <em>{jet.tag}</em>
        <dl className="showcase-specs">
          <div><dt>Span</dt><dd>{jet.span}</dd></div>
          <div><dt>Cruise</dt><dd>{jet.cruise}</dd></div>
          <div><dt>Range</dt><dd>{jet.range}</dd></div>
        </dl>
        <div className="showcase-dots">
          {SHOWCASE.map((item, itemIndex) => (
            <span key={item.code} className={itemIndex === index ? 'is-active' : undefined} />
          ))}
        </div>
      </div>
    </div>
  )
}

/** True when both ends resolved to real coordinates, which is what the route map needs to draw. */
function isMappable(entry: TrackEntry) {
  const route = entry.route
  return Boolean(
    route
    && typeof route.fromLat === 'number' && typeof route.fromLon === 'number'
    && typeof route.toLat === 'number' && typeof route.toLon === 'number',
  )
}

/** How long a tapped flight holds the map before it rejoins the rotation. */
const MAP_FOCUS_HOLD_MS = 45_000
/** How long each mappable flight holds the map when nothing is selected. */
const MAP_ROTATE_MS = 20_000
/** Minimum horizontal drag that counts as a swipe between map screens rather than a tap. */
const MAP_SWIPE_PX = 45

/** One screen in the map rotation: a single flight's route, or every tracked flight at once. */
type MapScreen = { kind: 'single'; entry: TrackEntry } | { kind: 'all' }

/** Sentinel focus value for the combined map, which has no flight number to key on. */
const ALL_ROUTES_FOCUS = '__all__'

/**
 * One pinned flight, in full. Every flight on the board gets one of these rather than the old
 * arrangement where the first pin got a detail card and the rest got a single-line row.
 */
function TrackedFlightCard({ entry, isFocused, mappable, onFocus, onRemove, busy }: {
  entry: TrackEntry
  isFocused: boolean
  mappable: boolean
  onFocus: () => void
  onRemove: () => void
  busy: boolean
}) {
  const schedule = entry.schedule ?? {}
  const progressPct = Math.round(Math.min(Math.max(entry.progress ?? 0, 0), 1) * 100)
  const callsign = entry.flight?.callsign ?? entry.query ?? '—'
  const eta = etaLabel(entry)

  return (
    <article
      className={`track-card ${isFocused ? 'is-focused' : ''} ${mappable ? 'is-mappable' : ''}`}
      role={mappable ? 'button' : undefined}
      tabIndex={mappable ? 0 : undefined}
      aria-pressed={mappable ? isFocused : undefined}
      title={mappable ? `Show ${callsign} on the map` : undefined}
      onClick={() => { if (mappable) onFocus() }}
      onKeyDown={(event) => {
        if (mappable && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onFocus()
        }
      }}
    >
      <header className="track-card-head">
        <AirlineLogo code={entry.flight?.airlineCode ?? null} />
        <div className="track-card-title">
          <strong>{callsign}</strong>
          <span>{entry.flight?.airline ?? entry.flight?.type ?? 'Awaiting signal'}</span>
        </div>
        <span className={`track-mode tone-${modeTone(entry.mode)}`}>{modeLabel(entry.mode)}</span>
        <button
          type="button"
          className="track-list-remove hit-area"
          aria-label={`Stop tracking ${entry.query ?? 'flight'}`}
          disabled={busy || !entry.query}
          onClick={(event) => { event.stopPropagation(); onRemove() }}
        >
          <X size={16} />
        </button>
      </header>

      <div className="track-route">
        <div className="track-route-end">
          <strong>{entry.route?.fromCode ?? '—'}</strong>
          <span>{entry.route?.fromCity ?? 'Not yet known'}</span>
        </div>
        <span className="track-route-arrow"><Plane size={15} /></span>
        <div className="track-route-end">
          <strong>{entry.route?.toCode ?? '—'}</strong>
          <span>{entry.route?.toCity ?? 'Not yet known'}</span>
        </div>
      </div>

      <div className="track-progress">
        <div className="track-progress-track glass-inset">
          <div className="track-progress-fill" style={{ transform: `scaleX(${progressPct / 100})` }} />
          <span className="track-progress-plane" style={{ left: `${progressPct}%` }}><Plane size={12} /></span>
        </div>
      </div>

      <div className="track-schedule">
        <div className="track-schedule-col">
          <span>Departure</span>
          <strong>{formatClock(schedule.depActual ?? schedule.depScheduled)}</strong>
        </div>
        <div className="track-schedule-col">
          <span>Arrival</span>
          <strong>{formatClock(schedule.arrEstimated ?? schedule.arrScheduled)}</strong>
        </div>
        <div className="track-schedule-col">
          <span>Status</span>
          <DelayBadge delayMin={schedule.delayMin} />
        </div>
      </div>

      {eta && <p className="track-eta">{eta}</p>}

      {/* "Awaiting" alone reads as a broken tracker; the backend says which kind of waiting it is. */}
      {entry.mode === 'await' && entry.awaitReason && (
        <p className="track-await-reason"><Info size={11} aria-hidden="true" />{entry.awaitReason}</p>
      )}

      {/* Units live in the label so the number itself always fits the column: at card width
          "34,000 ft" was being clipped to "34,00…". */}
      {entry.flight && (
        <div className="track-telemetry">
          <div><span>Alt ft</span><strong>{entry.flight.altitudeFt !== null ? formatNumber(entry.flight.altitudeFt) : '—'}</strong></div>
          <div><span>Speed kt</span><strong>{entry.flight.speedKt !== null ? formatNumber(entry.flight.speedKt) : '—'}</strong></div>
          <div><span>Track</span><strong>{entry.flight.trackDeg !== null ? `${Math.round(entry.flight.trackDeg)}°` : '—'}</strong></div>
          <div><span>Dist km</span><strong>{entry.flight.distanceKm !== null ? entry.flight.distanceKm.toFixed(0) : '—'}</strong></div>
        </div>
      )}

      {mappable && <span className="track-card-maphint"><MapIcon size={11} />{isFocused ? 'On the map' : 'Show on map'}</span>}
    </article>
  )
}

export function FlightsView({ entities, slide, onSelectSlide }: FlightsViewProps) {
  const [hoveredCallsign, setHoveredCallsign] = useState<string | null>(null)
  const [trackNotice, setTrackNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)

  const [queryInput, setQueryInput] = useState('')
  const [trackBusy, setTrackBusy] = useState(false)
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [quickAddValue, setQuickAddValue] = useState('')

  const coordinates = homeCoordinates(entities)
  const latitude = coordinates?.latitude ?? null
  const longitude = coordinates?.longitude ?? null

  // Both feeds come from the poller the header badge shares, so the page adds no requests of its own.
  const { track, trackError, nearby, nearbyError } = useFlightBoard(coordinates)

  // A notice that outlives the page would call setState on an unmounted component.
  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
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
        publishTrack(payload)
        setQueryInput('')
        setTrackNotice(`Tracking ${trimmed}`)
        if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
        noticeTimer.current = window.setTimeout(() => setTrackNotice(null), 4000)
      }
    } catch {
      // Network hiccup; the shared poll picks it back up.
    } finally {
      setTrackBusy(false)
    }
  }

  async function submitQuickAdd() {
    if (!quickAddValue.trim()) return
    await trackFlight(quickAddValue)
    setQuickAddValue('')
    setQuickAddOpen(false)
    onSelectSlide(1)
  }

  async function stopTracking() {
    setTrackBusy(true)
    try {
      await fetch(apiUrl('flights/track'), { method: 'DELETE' })
      publishTrack(null)
    } catch {
      // Network hiccup; the shared poll reconciles state.
    } finally {
      setTrackBusy(false)
    }
  }

  async function untrackFlight(query: string) {
    setTrackBusy(true)
    try {
      const response = await fetch(apiUrl(`flights/track?query=${encodeURIComponent(query)}`), { method: 'DELETE' })
      if (response.ok) {
        const payload: TrackResponse = await response.json()
        publishTrack(payload)
      }
    } catch {
      // Network hiccup; the shared poll reconciles state.
    } finally {
      setTrackBusy(false)
    }
  }

  const rangeKm = nearby?.home.rangeKm ?? 100
  const aircraftSorted = useMemo<Aircraft[]>(
    () => [...(nearby?.aircraft ?? [])]
      .sort((left, right) => (left.distanceKm ?? Infinity) - (right.distanceKm ?? Infinity))
      .slice(0, NEARBY_ROWS),
    [nearby],
  )

  const mapTiles = useMemo(() => {
    if (latitude === null || longitude === null) return []
    const centerX = lonToTileX(longitude, MAP_ZOOM)
    const centerY = latToTileY(latitude, MAP_ZOOM)
    const edge = Math.floor(MAP_GRID / 2)
    return Array.from({ length: MAP_GRID * MAP_GRID }, (_, index) => {
      const row = Math.floor(index / MAP_GRID)
      const col = index % MAP_GRID
      return { key: `${row}-${col}`, x: centerX - edge + col, y: centerY - edge + row }
    })
  }, [latitude, longitude])

  const ringRadii = Array.from({ length: RING_COUNT }, (_, index) => (RADAR_RADIUS / RING_COUNT) * (index + 1))
  const ticks = Array.from({ length: TICK_COUNT }, (_, index) => index * (360 / TICK_COUNT))
  const compassLabels: { label: string; deg: number }[] = [
    { label: 'N', deg: 0 },
    { label: 'E', deg: 90 },
    { label: 'S', deg: 180 },
    { label: 'W', deg: 270 },
  ]

  const trackedFlights = useMemo(() => track?.flights ?? [], [track])
  const atTrackCap = trackedFlights.length >= MAX_TRACKED

  // A tracked flight earns the top half of the page: the plane-icon showcase only runs when there
  // is no route to draw, which is the state it was written for.
  const mappableFlights = useMemo(() => trackedFlights.filter(isMappable), [trackedFlights])
  const [mapFocus, setMapFocus] = useState<string | null>(null)
  const [mapRotation, setMapRotation] = useState(0)

  // A wall panel should not stay on someone's stale tap, so a chosen flight releases the map back
  // to the rotation on its own.
  useEffect(() => {
    if (!mapFocus) return
    const timer = window.setTimeout(() => setMapFocus(null), MAP_FOCUS_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [mapFocus])

  // The per-flight maps plus, once there is more than one flight, a combined view of all of them.
  // Modelled as one extra screen in the same rotation rather than another slide, so the overview
  // arrives in the same swipe as the flights it summarises.
  const mapScreens = useMemo<MapScreen[]>(() => {
    const screens: MapScreen[] = mappableFlights.map((entry) => ({ kind: 'single', entry }))
    if (mappableFlights.length > 1) screens.push({ kind: 'all' })
    return screens
  }, [mappableFlights])

  useEffect(() => {
    if (mapScreens.length <= 1 || mapFocus) return
    const timer = window.setInterval(() => setMapRotation((value) => value + 1), MAP_ROTATE_MS)
    return () => window.clearInterval(timer)
  }, [mapScreens.length, mapFocus])

  // Derived rather than stored: flights are unpinned between polls, so an index into a shrinking
  // list has to wrap on read, and a focused flight that landed and expired falls back to rotation.
  const focusIndex = mapFocus === ALL_ROUTES_FOCUS
    ? mapScreens.findIndex((screen) => screen.kind === 'all')
    : mapScreens.findIndex((screen) => screen.kind === 'single' && screen.entry.query === mapFocus)
  const screenIndex = mapScreens.length === 0
    ? -1
    : focusIndex >= 0 ? focusIndex : mapRotation % mapScreens.length
  const screen = screenIndex >= 0 ? mapScreens[screenIndex] : null
  const mapped = screen?.kind === 'single' ? screen.entry : null

  function stepMap(delta: number) {
    if (mapScreens.length <= 1) return
    const next = (screenIndex + delta + mapScreens.length) % mapScreens.length
    const target = mapScreens[next]
    setMapFocus(target.kind === 'all' ? ALL_ROUTES_FOCUS : target.entry.query ?? null)
  }

  // Horizontal drags move between map screens; a vertical drag is the page's own scroll/swipe and
  // must pass through untouched.
  const mapSwipe = useRef<{ x: number; y: number } | null>(null)
  function onMapPointerDown(event: React.PointerEvent) {
    event.stopPropagation()
    mapSwipe.current = { x: event.clientX, y: event.clientY }
  }
  function onMapPointerUp(event: React.PointerEvent) {
    event.stopPropagation()
    const start = mapSwipe.current
    mapSwipe.current = null
    if (!start) return
    const deltaX = event.clientX - start.x
    const deltaY = event.clientY - start.y
    if (Math.abs(deltaX) < MAP_SWIPE_PX || Math.abs(deltaX) <= Math.abs(deltaY)) return
    stepMap(deltaX < 0 ? 1 : -1)
  }

  const panels = [
    { label: 'Radar', id: 'flights-panel-radar', tabId: 'flights-tab-radar' },
    { label: 'Track', id: 'flights-panel-track', tabId: 'flights-tab-track' },
  ]
  const activePanel = panels[slide] ?? panels[0]

  // The nearby list has four honest states, and each needs its own words: no home location means
  // the radar can never load, which is different from a feed that failed or a sky that is empty.
  let nearbyState: React.ReactNode = null
  if (!coordinates) {
    nearbyState = (
      <EmptyState
        size="compact"
        icon={<MapPinOff />}
        title="Home location not set"
        hint="Looks for latitude and longitude on zone.home or a weather.* entity"
      />
    )
  } else if (nearbyError && aircraftSorted.length === 0) {
    nearbyState = <InlineError message={`Radar feed unavailable: ${nearbyError}`} onRetry={refreshFlightBoard} />
  } else if (!nearby && !nearbyError) {
    nearbyState = <LoadingState size="compact" label="Loading nearby traffic" />
  } else if (aircraftSorted.length === 0) {
    nearbyState = <EmptyState size="compact" icon={<RadarIcon />} title="No aircraft in range" hint={`Nothing reporting within ${formatNumber(rangeKm)} km of home`} />
  }

  return (
    <section className="flights-view" aria-label="Flight tracker">
      <div
        className="flights-panel-shell glass"
        role="tabpanel"
        id={activePanel.id}
        aria-labelledby={activePanel.tabId}
        aria-live="polite"
      >
        {slide === 0 && (
          <section className="flights-panel radar-panel" aria-label="Nearby aircraft radar">
            <div className="radar-column">
              <div className="radar-scope">
                {mapTiles.length > 0 && (
                  <div className="radar-map" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${MAP_GRID}, 1fr)`, gridTemplateRows: `repeat(${MAP_GRID}, 1fr)` }}>
                    {mapTiles.map((tile) => (
                      <img key={tile.key} src={`https://a.basemaps.cartocdn.com/dark_nolabels/${MAP_ZOOM}/${tile.x}/${tile.y}.png`} alt="" loading="eager" />
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
              {nearby && <p className="radar-meta">{`${aircraftSorted.length} tracked within ${formatNumber(rangeKm)} km`}</p>}
            </div>

            <div className="flights-list-column">
              <header className="flights-list-heading">
                <span aria-hidden="true"><RadarIcon size={16} /></span>
                <div><strong>Nearby traffic</strong><p>Tap a row to track it</p></div>
              </header>
              {trackNotice && <p className="flights-list-notice" role="status">{trackNotice}</p>}
              {/* A failed poll with the last list still on screen: say so without hiding the list. */}
              {nearbyError && aircraftSorted.length > 0 && <InlineError message={`Radar feed stale: ${nearbyError}`} onRetry={refreshFlightBoard} />}
              <div className="flights-list">
                {nearbyState}
                {aircraftSorted.map((aircraft) => {
                  const phase = phaseOf(aircraft)
                  const isActive = hoveredCallsign === aircraft.callsign
                  return (
                    <button
                      key={aircraft.icao24}
                      type="button"
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
            {screen ? (
              <div className="track-stage" data-swipe-ignore onPointerDown={onMapPointerDown} onPointerUp={onMapPointerUp}>
                {screen.kind === 'all' ? (
                  <AllRoutesMap
                    routes={mappableFlights.map((entry) => ({
                      key: entry.query ?? entry.flight?.icao24 ?? '',
                      callsign: entry.flight?.callsign ?? entry.query ?? '—',
                      from: { code: entry.route?.fromCode ?? null, lat: entry.route?.fromLat ?? null, lon: entry.route?.fromLon ?? null },
                      to: { code: entry.route?.toCode ?? null, lat: entry.route?.toLat ?? null, lon: entry.route?.toLon ?? null },
                      position: entry.flight ? { lat: entry.flight.lat, lon: entry.flight.lon, trackDeg: entry.flight.trackDeg } : null,
                      flownPath: entry.flownPath,
                      progress: entry.progress,
                      isLanded: entry.mode === 'landed',
                    }))}
                  />
                ) : (
                  <RouteMap
                    from={{
                      code: screen.entry.route?.fromCode ?? null,
                      city: screen.entry.route?.fromCity ?? null,
                      lat: screen.entry.route?.fromLat ?? null,
                      lon: screen.entry.route?.fromLon ?? null,
                    }}
                    to={{
                      code: screen.entry.route?.toCode ?? null,
                      city: screen.entry.route?.toCity ?? null,
                      lat: screen.entry.route?.toLat ?? null,
                      lon: screen.entry.route?.toLon ?? null,
                    }}
                    position={screen.entry.flight ? { lat: screen.entry.flight.lat, lon: screen.entry.flight.lon, trackDeg: screen.entry.flight.trackDeg } : null}
                    flownPath={screen.entry.flownPath}
                    progress={screen.entry.progress}
                    callsign={screen.entry.flight?.callsign ?? screen.entry.query}
                    caption={screen.entry.mode === 'await' ? 'Route · awaiting position' : etaLabel(screen.entry) ?? shortModeLabel(screen.entry.mode)}
                  />
                )}
                {mapScreens.length > 1 && (
                  <div className="track-stage-dots">
                    {mapScreens.map((item, index) => (
                      <button
                        key={item.kind === 'all' ? ALL_ROUTES_FOCUS : item.entry.query ?? item.entry.flight?.icao24 ?? index}
                        type="button"
                        className={`${index === screenIndex ? 'is-active' : ''} ${item.kind === 'all' ? 'is-all' : ''}`.trim()}
                        onClick={() => setMapFocus(item.kind === 'all' ? ALL_ROUTES_FOCUS : item.entry.query ?? null)}
                        aria-label={item.kind === 'all' ? 'Show every tracked flight on one map' : `Show ${item.entry.query ?? 'this flight'} on the map`}
                        aria-current={index === screenIndex}
                      />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <TrackShowcase />
            )}
            <div className="track-console">
            <form
              className="track-form"
              onSubmit={(event) => {
                event.preventDefault()
                trackFlight(queryInput)
              }}
            >
              <div className="track-input-wrap glass-inset">
                <Search size={15} aria-hidden="true" />
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
              <button type="button" className="track-action track-action-stop" onClick={stopTracking} disabled={trackedFlights.length === 0 || trackBusy}>
                <X size={14} />Clear all
              </button>
            </form>

            {atTrackCap && <p className="track-cap-hint">Board full ({MAX_TRACKED}) — adding another drops the oldest.</p>}

            {trackError && <InlineError message={trackedFlights.length > 0 ? `Tracker stale: ${trackError}` : `Tracker unavailable: ${trackError}`} onRetry={refreshFlightBoard} />}

            {trackedFlights.length === 0 ? (
              <EmptyState
                className="track-empty"
                icon={<PlaneTakeoff />}
                title="No flight pinned"
                hint="Track one from the Radar page or type a flight number above."
              />
            ) : (
              <div className="track-board" aria-label="Tracked flights">
                {trackedFlights.map((entry, index) => (
                  <TrackedFlightCard
                    key={entry.query ?? `pin-${index}`}
                    entry={entry}
                    isFocused={entry === mapped}
                    mappable={isMappable(entry)}
                    busy={trackBusy}
                    onFocus={() => setMapFocus(entry.query)}
                    onRemove={() => { if (entry.query) void untrackFlight(entry.query) }}
                  />
                ))}
              </div>
            )}

            </div>
          </section>
        )}
      </div>

      {slide === 0 && (
        <div className="flights-quick-add">
          {quickAddOpen ? (
            <form
              className="quick-add-form glass-pill"
              onSubmit={(event) => { event.preventDefault(); void submitQuickAdd() }}
            >
              <Search size={14} aria-hidden="true" />
              <input
                autoFocus
                type="text"
                value={quickAddValue}
                onChange={(event) => setQuickAddValue(event.target.value.toUpperCase())}
                onKeyDown={(event) => { if (event.key === 'Escape') { setQuickAddOpen(false); setQuickAddValue('') } }}
                placeholder="Flight number"
                style={{ textTransform: 'uppercase' }}
                aria-label="Flight number to track"
              />
              <button type="submit" className="quick-add-confirm" disabled={!quickAddValue.trim() || trackBusy} aria-label="Track this flight">
                <Plus size={16} />
              </button>
              <button type="button" className="quick-add-close" onClick={() => { setQuickAddOpen(false); setQuickAddValue('') }} aria-label="Cancel">
                <X size={16} />
              </button>
            </form>
          ) : (
            <button type="button" className="quick-add-fab glass-pill" onClick={() => setQuickAddOpen(true)} title="Track a flight by number" aria-label="Track a flight by number">
              <Plus size={20} />
            </button>
          )}
        </div>
      )}

      <div
        className="flights-pager"
        role="tablist"
        aria-label="Flights panels"
        onKeyDown={tabListKeyHandler(panels.map((_, index) => index), slide, onSelectSlide)}
      >
        {panels.map((panel, index) => {
          const selected = slide === index
          return (
            <button
              key={panel.label}
              type="button"
              role="tab"
              id={panel.tabId}
              aria-selected={selected}
              aria-controls={panel.id}
              tabIndex={selected ? 0 : -1}
              className={`glass-pill ${selected ? 'is-active' : ''}`.trim()}
              onClick={() => onSelectSlide(index)}
              title={`Show ${panel.label} panel`}
            >
              <span>{panel.label}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
