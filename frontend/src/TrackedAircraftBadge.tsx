import { Crosshair, Locate } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AirlineLogo } from './AirlineLogo'
import { aircraftFamily } from './aircraftSilhouettes'
import type { AircraftFamily } from './aircraftSilhouettes'
import { apiUrl } from './api'
import type { HAEntity } from './types'
import { homeCoordinates } from './useServiceStatus'
import './TrackedAircraftBadge.css'
import a320Icon from './assets/aircraft/a320.svg'
import a330Icon from './assets/aircraft/a330.svg'
import a340Icon from './assets/aircraft/a340.svg'
import a350Icon from './assets/aircraft/a350.svg'
import a380Icon from './assets/aircraft/a380.svg'
import b737Icon from './assets/aircraft/b737.svg'
import b747Icon from './assets/aircraft/b747.svg'
import b767Icon from './assets/aircraft/b767.svg'
import b777Icon from './assets/aircraft/b777.svg'
import b787Icon from './assets/aircraft/b787.svg'
import crjxIcon from './assets/aircraft/crjx.svg'
import md11Icon from './assets/aircraft/md11.svg'

interface TrackRoute {
  fromCode: string | null
  fromCity: string | null
  toCode: string | null
  toCity: string | null
}

interface TrackSchedule {
  depScheduled?: string | null
  depActual?: string | null
  arrScheduled?: string | null
  arrEstimated?: string | null
  delayMin?: number | null
  status?: string | null
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
}

function iconForAircraft(type: string | null | undefined) {
  const token = (type ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (/A38[0-9X]/.test(token)) return a380Icon
  if (/A35[0-9KX]/.test(token)) return a350Icon
  if (/A34[0-9X]/.test(token)) return a340Icon
  if (/A33[0-9X]/.test(token)) return a330Icon
  if (/B74[0-9SRFM]/.test(token) || /747/.test(token)) return b747Icon
  if (/B77[0-9WL]/.test(token) || /777/.test(token)) return b777Icon
  if (/B78[0-9X]/.test(token) || /787/.test(token)) return b787Icon
  if (/B76[0-9]/.test(token) || /767/.test(token)) return b767Icon
  if (/MD11|L101/.test(token)) return md11Icon
  if (/CRJ|ERJ|E1(3[05]|4[05]|70|75|90|95)|E75[LS]/.test(token)) return crjxIcon
  if (/B73[0-9HMS]|A32[01]|A31[89]|737|320/.test(token)) return b737Icon
  return a320Icon
}

function PackAircraftIcon({ type, size, className }: { type: string | null | undefined; size: number; className?: string }) {
  const icon = iconForAircraft(type)
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        display: 'inline-block',
        backgroundColor: 'currentColor',
        maskImage: `url(${icon})`,
        WebkitMaskImage: `url(${icon})`,
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
      }}
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

/** Upstream sends "2026-08-04 06:15"; only the clock time fits in a header chip. */
function clockOf(value: string | null | undefined) {
  if (!value) return null
  const match = /(\d{1,2}:\d{2})/.exec(value)
  return match ? match[1] : null
}

/**
 * Delay is the one number worth colouring: on time reads green, a slip reads amber, and a real
 * delay reads red. A null delay means the schedule source simply has not said yet — that is not
 * the same as on time, so it stays neutral rather than claiming good news.
 */
function delayChip(schedule: TrackSchedule | undefined) {
  const delay = schedule?.delayMin
  if (delay === null || delay === undefined) {
    const status = schedule?.status
    return status ? { tone: 'muted', label: status.replace(/^./, (c) => c.toUpperCase()) } : null
  }
  if (delay <= 0) return { tone: 'good', label: 'On time' }
  if (delay <= 15) return { tone: 'warn', label: `+${Math.round(delay)}m` }
  return { tone: 'danger', label: `+${Math.round(delay)}m` }
}

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
  const chip = isTracked ? delayChip(track?.schedule) : null
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

      {isTracked && (eta || chip) && (
        <div className="flight-eta">
          {eta && <strong>{eta}</strong>}
          {chip && <span className={`flight-delay tone-${chip.tone}`}>{chip.label}</span>}
        </div>
      )}
    </div>
  )
}
