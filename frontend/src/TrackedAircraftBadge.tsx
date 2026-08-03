import { Crosshair, Locate } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AirlineLogo } from './AirlineLogo'
import { aircraftFamily } from './aircraftSilhouettes'
import type { AircraftFamily } from './aircraftSilhouettes'
import { apiUrl } from './api'
import { AIRCRAFT_ART, arrivalVerdict, artKeyForAircraft, clockOf } from './flightBadge'
import type { TrackSchedule } from './flightBadge'
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

interface TrackResponse {
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

/** How long each of the two readings holds when a pinned flight and an overhead airliner both exist. */
const ALTERNATE_MS = 30_000

/**
 * Header chip for what is in the sky. A flight pinned from the Flights page wins, because pinning
 * is a deliberate choice; otherwise this falls back to the nearest passenger jet overhead. A symbol
 * rather than a caption says which of the two is showing, keeping the space for the flight itself.
 */
export function TrackedAircraftBadge({ entities }: { entities: Map<string, HAEntity> }) {
  const [track, setTrack] = useState<TrackResponse | null>(null)
  const [nearest, setNearest] = useState<NearbyAircraft | null>(null)
  const [showingNearest, setShowingNearest] = useState(false)
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
    const timer = window.setInterval(load, 10_000)
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

  const hasTracked = Boolean(track?.query && track.mode)
  const hasNearest = Boolean(nearest?.callsign)

  useEffect(() => {
    if (!hasTracked || !hasNearest) return
    const timer = window.setInterval(() => setShowingNearest((current) => !current), ALTERNATE_MS)
    return () => window.clearInterval(timer)
  }, [hasTracked, hasNearest])

  // With a flight pinned there are two things worth showing and only one slot, so they take turns
  // rather than the pin hiding the sky for as long as it stays pinned.
  const isTracked = hasTracked && (!hasNearest || !showingNearest)
  const aircraft = isTracked ? track?.flight ?? null : nearest
  const callsign = isTracked ? track?.flight?.callsign ?? track?.query ?? null : nearest?.callsign ?? null

  // An empty sky still holds the centre slot, so the header keeps its shape as flights come and go.
  if (!callsign) {
    return (
      <div className="flight-banner is-idle" title="No tracked flight and no passenger jet overhead">
        <span className="flight-mode" aria-hidden="true"><PackAircraftIcon type={null} size={15} /></span>
        <div className="flight-body">
          <div className="flight-identity"><strong>Sky clear</strong><em>No jets overhead</em></div>
        </div>
      </div>
    )
  }

  const type = aircraft?.type ?? null
  const from = isTracked ? track?.route?.fromCode ?? null : nearest?.fromCode ?? null
  const to = isTracked ? track?.route?.toCode ?? null : nearest?.toCode ?? null
  const tone = isTracked ? (track?.mode === 'track' ? 'good' : track?.mode === 'landed' ? 'accent' : 'muted') : 'accent'

  const progress = Math.max(0, Math.min(1, track?.progress ?? 0))
  const eta = clockOf(track?.schedule?.arrEstimated ?? track?.schedule?.arrScheduled)
  const verdict = isTracked ? arrivalVerdict(track?.schedule) : null
  const arrival = eta ? `Arrives ${eta}` : track?.etaLine ?? null
  const distance = !isTracked && nearest?.distanceKm != null ? `${Math.round(nearest.distanceKm)} km` : null

  return (
    <div
      className={`flight-banner tone-${tone} ${isTracked ? 'is-tracking' : 'is-nearest'}`}
      title={isTracked ? `Tracking ${callsign}` : `Nearest passenger jet overhead: ${callsign}${type ? ` · ${type}` : ''}`}
    >
      <span className="flight-mode" aria-label={isTracked ? 'Tracking this flight' : 'Nearest aircraft overhead'}>
        {isTracked ? <Crosshair size={15} aria-hidden="true" /> : <Locate size={15} aria-hidden="true" />}
      </span>

      <PackAircraftIcon type={type} size={68} className="flight-silhouette" />

      <div className="flight-body">
        <div className="flight-identity">
          <AirlineLogo code={aircraft?.airlineCode ?? null} className="flight-logo" />
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
      </div>

      {isTracked && (arrival || verdict) && (
        <div className="flight-eta">
          {arrival && <strong>{arrival}</strong>}
          {verdict && <span className={`flight-delay tone-${verdict.tone}`}>{verdict.label}</span>}
        </div>
      )}
    </div>
  )
}
