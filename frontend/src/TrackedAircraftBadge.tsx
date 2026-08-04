import { Crosshair, Locate } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AirlineLogo } from './AirlineLogo'
import { aircraftFamily } from './aircraftSilhouettes'
import type { AircraftFamily } from './aircraftSilhouettes'
import { apiUrl } from './api'
import { AIRCRAFT_ART, arrivalVerdict, artKeyForAircraft, clockOf } from './flightBadge'
import type { TrackSchedule } from './flightBadge'
import { FLIGHTS_RADAR_SLIDE, FLIGHTS_TRACK_SLIDE } from './flightsSlides'
import type { HAEntity } from './types'
import { homeCoordinates } from './useServiceStatus'
import './TrackedAircraftBadge.css'

interface TrackRoute {
  fromCode: string | null
  fromCity: string | null
  toCode: string | null
  toCity: string | null
}

interface NearbyAircraft {
  callsign: string | null
  airline: string | null
  airlineCode: string | null
  type: string | null
  kind: string | null
  fromCode: string | null
  toCode: string | null
  altitudeFt: number | null
  distanceKm: number | null
}

interface TrackEntry {
  query: string | null
  mode: 'track' | 'landed' | 'await' | null
  flight: NearbyAircraft | null
  route: TrackRoute | null
  schedule?: TrackSchedule
  /** 0..1 along the great-circle route, from the backend's own progress maths. */
  progress?: number
  /** Live time-to-run from ground speed, e.g. "in 42 min"; the only ETA when no schedule exists. */
  etaLine?: string | null
}

/** The first pinned flight stays flattened at the top level; `flights` carries all of them. */
interface TrackResponse extends TrackEntry {
  flights?: TrackEntry[]
}

/** One slot in the rotation: either a pinned flight or the nearest airliner overhead. */
type Reading = { kind: 'tracked'; entry: TrackEntry } | { kind: 'nearest'; aircraft: NearbyAircraft }

/**
 * Rendered as real inline SVG rather than a CSS mask: a mask silently degrades to a solid coloured
 * block whenever the asset URL fails to resolve, which is exactly what happens behind Home
 * Assistant's ingress path rewriting. Inlining removes the fetch, so the silhouette cannot go missing.
 */
function PackAircraftIcon({ type, size, className }: { type: string | null | undefined; size: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="currentColor"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: AIRCRAFT_ART[artKeyForAircraft(type)] }}
    />
  )
}

/**
 * Passenger jets only: no general aviation, no turboprops, no business jets, no helicopters.
 * Georgetown Municipal is a training field, so most of what is actually overhead is a Cessna
 * doing circuits.
 *
 * This filters on the aircraft *type* rather than the backend's `kind`, because `kind` matches
 * fixed needles against free-text type strings and quietly misses punctuation variants — a real
 * sample overhead had a Pilatus PC-12 arriving as "PC-XII NGX" and an AW169 helicopter as
 * "AW.169", both of which `kind` labelled `jet`. Deriving the family from the type string catches
 * those, and it is the same function that picks the silhouette, so the filter and the picture can
 * never disagree.
 */
const PASSENGER_FAMILIES = new Set<AircraftFamily>(['narrowbody', 'widebody', 'quadjet', 'regionaljet'])

function isPassengerJet(aircraft: NearbyAircraft) {
  return PASSENGER_FAMILIES.has(aircraftFamily(aircraft.type))
}

/** How long each reading holds before the banner rotates to the next one. */
const ALTERNATE_MS = 30_000
/** Minimum horizontal drag that counts as a swipe between flights rather than a tap. */
const SWIPE_PX = 40

/**
 * Header chip for what is in the sky. Every flight pinned from the Flights page takes a turn,
 * followed by the nearest passenger jet overhead, so pinning never permanently hides the sky.
 * A symbol rather than a caption says which kind is showing, keeping the space for the flight itself.
 */
export function TrackedAircraftBadge({ entities, onOpenFlights }: { entities: Map<string, HAEntity>; onOpenFlights?: (slide: number) => void }) {
  const [track, setTrack] = useState<TrackResponse | null>(null)
  const [nearest, setNearest] = useState<NearbyAircraft | null>(null)
  const [step, setStep] = useState(0)
  // Declared with the other hooks rather than beside the swipe handlers below, which sit after this
  // component's early return for an empty sky.
  const swipe = useRef<{ x: number; y: number } | null>(null)
  const swiped = useRef(false)
  const coordinates = homeCoordinates(entities)
  const latitude = coordinates?.latitude ?? null
  const longitude = coordinates?.longitude ?? null

  useEffect(() => {
    let cancelled = false

    function load() {
      fetch(apiUrl('flights/track'))
        .then(async (response) => {
          if (!response.ok) throw new Error('Track endpoint unavailable')
          const payload: TrackResponse = await response.json()
          if (!cancelled) setTrack(payload)
        })
        .catch(() => {
          // Keep the last known badge state; the next poll retries.
        })
    }

    load()
    // Each poll costs one upstream lookup per pinned flight, so this is deliberately slower than
    // the banner's 30s rotation -- the flight on screen changes far more often than its data does.
    const timer = window.setInterval(load, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (latitude === null || longitude === null) return
    let cancelled = false

    function load() {
      // The backend caches this query for 60s, so polling faster would only burn OpenSky quota.
      fetch(apiUrl(`flights/nearby?latitude=${latitude}&longitude=${longitude}&limit=25`))
        .then(async (response) => {
          if (!response.ok) throw new Error('Nearby endpoint unavailable')
          const payload: { aircraft?: NearbyAircraft[] } = await response.json()
          if (cancelled) return
          // Already distance-sorted upstream, so the first passenger jet is the closest one.
          setNearest((payload.aircraft ?? []).find(isPassengerJet) ?? null)
        })
        .catch(() => {})
    }

    load()
    const timer = window.setInterval(load, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [latitude, longitude])

  const readings = useMemo<Reading[]>(() => {
    // Older backends only sent the flattened first flight; treat that as a one-entry list.
    const pinned = track?.flights ?? (track ? [track] : [])
    const list: Reading[] = pinned
      .filter((entry) => Boolean(entry.query) || entry.flight !== null)
      .map((entry) => ({ kind: 'tracked', entry }))
    if (nearest?.callsign) list.push({ kind: 'nearest', aircraft: nearest })
    return list
  }, [track, nearest])

  useEffect(() => {
    if (readings.length <= 1) return
    const timer = window.setInterval(() => setStep((current) => current + 1), ALTERNATE_MS)
    return () => window.clearInterval(timer)
  }, [readings.length])

  // Flights are pinned and unpinned between polls, so the position is derived rather than stored:
  // wrapping on read means a shrinking list can never leave the index pointing past the end.
  const position = readings.length > 0 ? step % readings.length : 0

  // Swiping the banner steps through the flights by hand. `step` only ever increases, so moving
  // back adds `readings.length - 1` rather than subtracting -- keeping it non-negative means the
  // modulo above stays correct.
  function onPointerDown(event: React.PointerEvent) {
    swipe.current = { x: event.clientX, y: event.clientY }
  }
  function onPointerUp(event: React.PointerEvent) {
    const start = swipe.current
    swipe.current = null
    if (!start) return
    const deltaX = event.clientX - start.x
    const deltaY = event.clientY - start.y
    // A short or mostly-vertical drag is a tap or the page's own gesture, and must fall through to
    // the click handler that opens the Flights page.
    if (Math.abs(deltaX) < SWIPE_PX || Math.abs(deltaX) <= Math.abs(deltaY)) return
    if (readings.length > 1) setStep((current) => current + (deltaX < 0 ? 1 : readings.length - 1))
    swiped.current = true
  }

  function openFlights(slide: number) {
    // A swipe ends in a click event too, which would otherwise navigate away from the flight the
    // swipe just brought into view.
    if (swiped.current) {
      swiped.current = false
      return
    }
    onOpenFlights?.(slide)
  }
  const reading = readings[position] ?? null
  const entry = reading?.kind === 'tracked' ? reading.entry : null
  const overhead = reading?.kind === 'nearest' ? reading.aircraft : null
  const isTracked = entry !== null
  const aircraft = entry ? entry.flight : overhead
  const callsign = entry ? entry.flight?.callsign ?? entry.query ?? null : overhead?.callsign ?? null

  // An empty sky still holds the centre slot, so the header keeps its shape as flights come and go.
  if (!callsign) {
    return (
      <div
        className={`flight-banner is-idle ${onOpenFlights ? 'is-linked' : ''}`.trim()}
        title={onOpenFlights ? 'No tracked flight and no passenger jet overhead — open the radar' : 'No tracked flight and no passenger jet overhead'}
        onClick={onOpenFlights ? () => onOpenFlights(FLIGHTS_RADAR_SLIDE) : undefined}
        onKeyDown={onOpenFlights ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpenFlights(FLIGHTS_RADAR_SLIDE)
          }
        } : undefined}
        role={onOpenFlights ? 'button' : undefined}
        tabIndex={onOpenFlights ? 0 : undefined}
      >
        <span className="flight-mode" aria-hidden="true"><PackAircraftIcon type={null} size={15} /></span>
        <div className="flight-body">
          <div className="flight-identity"><strong>Sky clear</strong><em>No jets overhead</em></div>
        </div>
      </div>
    )
  }

  const type = aircraft?.type ?? null
  const from = entry ? entry.route?.fromCode ?? null : overhead?.fromCode ?? null
  const to = entry ? entry.route?.toCode ?? null : overhead?.toCode ?? null
  const tone = entry ? (entry.mode === 'track' ? 'good' : entry.mode === 'landed' ? 'accent' : 'muted') : 'accent'

  const progress = Math.max(0, Math.min(1, entry?.progress ?? 0))
  const eta = clockOf(entry?.schedule?.arrEstimated ?? entry?.schedule?.arrScheduled)
  const verdict = entry ? arrivalVerdict(entry.schedule) : null
  const arrival = eta ? `Arrives ${eta}` : entry?.etaLine ?? null
  const distance = overhead?.distanceKm != null ? `${Math.round(overhead.distanceKm)} km` : null

  // The banner shows one of two different things, and each has its own page: tapping a pinned
  // flight should land on the route map, tapping the jet overhead on the radar. Sending both to
  // the same slide would make half the taps look like they went to the wrong place.
  const targetSlide = isTracked ? FLIGHTS_TRACK_SLIDE : FLIGHTS_RADAR_SLIDE
  const destination = isTracked ? 'Open the tracking page' : 'Open the radar'

  return (
    <div
      className={`flight-banner tone-${tone} ${isTracked ? 'is-tracking' : 'is-nearest'} ${onOpenFlights ? 'is-linked' : ''}`.trim()}
      title={`${isTracked ? `Tracking ${callsign}` : `Nearest passenger jet overhead: ${callsign}${type ? ` · ${type}` : ''}`} — ${destination}${readings.length > 1 ? ' · swipe for the next flight' : ''}`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onClick={onOpenFlights ? () => openFlights(targetSlide) : undefined}
      onKeyDown={(event) => {
        // Arrow keys step the rotation; Enter/Space follows the banner to the Flights page.
        if (readings.length > 1 && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
          event.preventDefault()
          setStep((current) => current + (event.key === 'ArrowRight' ? 1 : readings.length - 1))
          return
        }
        if (onOpenFlights && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onOpenFlights(targetSlide)
        }
      }}
      role={onOpenFlights ? 'button' : undefined}
      tabIndex={onOpenFlights ? 0 : undefined}
    >
      <span className="flight-mode" aria-label={isTracked ? 'Tracking this flight' : 'Nearest aircraft overhead'}>
        {isTracked ? <Crosshair size={15} aria-hidden="true" /> : <Locate size={15} aria-hidden="true" />}
      </span>

      <PackAircraftIcon type={type} size={68} className="flight-silhouette" />

      <div className="flight-body">
        <div className="flight-identity">
          <strong>{callsign}</strong>
          {distance && <span className="flight-distance">{distance}</span>}
        </div>

        {isTracked ? (
          <div className="flight-progress">
            <span className="flight-port">{from ?? '—'}</span>
            <span className="flight-track" role="presentation">
              <span className="flight-track-fill" style={{ width: `${progress * 100}%` }} />
              <span className="flight-track-dot" style={{ left: `${progress * 100}%` }} />
            </span>
            <span className="flight-port">{to ?? '—'}</span>
          </div>
        ) : (
          <div className="flight-route">
            <span>{from ?? '—'}</span>
            <i aria-hidden="true" />
            <span>{to ?? '—'}</span>
          </div>
        )}

        {readings.length > 1 && (
          <span className="flight-dots">
            {readings.map((item, order) => (
              <i
                key={`${item.kind}-${item.kind === 'tracked' ? item.entry.query ?? order : item.aircraft.callsign ?? order}`}
                className={order === position ? 'is-active' : ''}
                // Stops the parent's click handler from also opening the Flights page: picking a
                // flight to look at here is a different intent from navigating to it.
                onClick={(event) => { event.stopPropagation(); setStep(order) }}
              />
            ))}
          </span>
        )}
      </div>

      {isTracked && (arrival || verdict) && (
        <div className="flight-eta">
          {arrival && <strong>{arrival}</strong>}
          {verdict && <span className={`flight-delay tone-${verdict.tone}`}>{verdict.label}</span>}
        </div>
      )}

      <div className="flight-airline">
        <AirlineLogo code={aircraft?.airlineCode ?? null} className="flight-logo" />
      </div>
    </div>
  )
}
