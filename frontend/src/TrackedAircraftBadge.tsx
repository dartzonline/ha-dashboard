import { useEffect, useState } from 'react'
import { AirlineLogo } from './AirlineLogo'
import { AircraftSilhouette, aircraftFamily } from './aircraftSilhouettes'
import type { AircraftFamily } from './aircraftSilhouettes'
import { apiUrl } from './api'
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

function displayRoute(from: string | null, to: string | null) {
  if (!from && !to) return null
  return `${from ?? '—'} → ${to ?? '—'}`
}

/**
 * Header chip for what is in the sky. A flight pinned from the Flights page wins, because pinning
 * is a deliberate choice; otherwise this falls back to the nearest airliner overhead. The label
 * says which of the two is showing, so a pinned flight is never mistaken for what is above you.
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
          // Already distance-sorted upstream, so the first airliner is the closest one.
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
  const route = isTracked
    ? displayRoute(track?.route?.fromCode ?? null, track?.route?.toCode ?? null)
    : displayRoute(nearest?.fromCode ?? null, nearest?.toCode ?? null)

  // Nothing pinned and an empty sky is the normal quiet case, not an error worth a placeholder.
  if (!callsign) return null

  const type = aircraft?.type ?? null
  const tone = isTracked ? (track?.mode === 'track' ? 'good' : track?.mode === 'landed' ? 'accent' : 'muted') : 'accent'
  const distance = !isTracked && nearest?.distanceKm != null ? `${Math.round(nearest.distanceKm)} km` : null

  return (
    <div
      className={`tracked-aircraft-badge tone-${tone}`}
      title={isTracked ? `Tracking ${callsign}` : `Nearest airliner: ${callsign}${type ? ` · ${type}` : ''}`}
    >
      <AircraftSilhouette family={aircraftFamily(type)} size={30} className="badge-silhouette" />
      <AirlineLogo code={aircraft?.airlineCode ?? null} className="badge-airline-logo" />
      <div className="badge-copy">
        <span className="badge-kind">{isTracked ? 'Tracking' : 'Nearest overhead'}</span>
        <strong>{callsign}</strong>
      </div>
      <div className="badge-route">
        {route && <span>{route}</span>}
        <small>{[type, distance].filter(Boolean).join(' · ') || (isTracked ? 'Pinned flight' : 'Overhead')}</small>
      </div>
    </div>
  )
}
