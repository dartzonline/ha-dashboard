import { useEffect, useState } from 'react'
import { Plane } from 'lucide-react'
import { apiUrl } from './api'
import './TrackedAircraftBadge.css'

interface TrackRoute {
  fromCode: string
  fromCity: string
  toCode: string
  toCity: string
}

interface TrackResponse {
  query: string | null
  mode: 'track' | 'landed' | 'await' | null
  flight: { callsign: string } | null
  route: TrackRoute | null
}

function modeTone(mode: TrackResponse['mode']): 'good' | 'accent' | 'muted' {
  if (mode === 'track') return 'good'
  if (mode === 'landed') return 'accent'
  return 'muted'
}

/** Self-contained header status chip: polls the pinned-flight endpoint on its own and renders nothing when no flight is pinned. */
export function TrackedAircraftBadge() {
  const [track, setTrack] = useState<TrackResponse | null>(null)

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

  if (!track || !track.query || !track.mode) return null

  const callsign = track.flight?.callsign ?? track.query
  const routeLabel = track.route ? `${track.route.fromCode} → ${track.route.toCode}` : null

  return (
    <div className={`tracked-aircraft-badge tone-${modeTone(track.mode)}`} title={`Tracking ${callsign}`}>
      <Plane size={13} />
      <strong>{callsign}</strong>
      {routeLabel && <span>{routeLabel}</span>}
    </div>
  )
}
