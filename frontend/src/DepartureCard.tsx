import { useEffect, useState } from 'react'
import { BatteryCharging, Car, Flame, Plug, Snowflake } from 'lucide-react'
import { cachedJson } from './cachedFetch'
import { departureStatus, type DeparturePayload } from './applianceFormat'
import { useTwoTapConfirm } from './ui/useTwoTapConfirm'
import './DepartureCard.css'

const DEPARTURE_PATH = 'car/departure'
const DEPARTURE_TTL_MS = 5 * 60_000

interface DepartureCardProps {
  onService: (domain: string, service: string, data: Record<string, unknown>) => Promise<unknown>
}

/** "Leaving 8:30 am": the charge the car will have by then, and a warm-up on cold mornings. */
export function DepartureCard({ onService }: DepartureCardProps) {
  const [data, setData] = useState<DeparturePayload | null>(null)
  const [started, setStarted] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle')
  const confirm = useTwoTapConfirm()

  useEffect(() => {
    const abort = new AbortController()
    const load = (force = false) => cachedJson<DeparturePayload>(DEPARTURE_PATH, DEPARTURE_PATH, DEPARTURE_TTL_MS, { signal: abort.signal, force })
      .then((value) => { if (typeof value?.available === 'boolean') setData(value) })
      // A failed refresh keeps showing the last plan; the card is an extra, never an error banner.
      .catch(() => undefined)
    void load()
    const timer = window.setInterval(() => void load(true), DEPARTURE_TTL_MS)
    return () => { abort.abort(); window.clearInterval(timer) }
  }, [])

  const leave = data?.available ? data.departure : null
  if (!data?.available || !leave) return null
  const status = departureStatus(leave)
  const climate = leave.climate && data.climateButton ? leave.climate : null

  async function startClimate() {
    if (!data?.climateButton || !confirm.request()) return
    setStarted('busy')
    try {
      await onService('button', 'press', { entity_id: data.climateButton })
      setStarted('done')
    } catch {
      setStarted('failed')
    }
  }

  const now = leave.level ?? 0
  const then = leave.levelAtDeparture ?? now
  return (
    <section className={`departure-card glass is-${status.tone}`} aria-label="Leaving with the car">
      <header>
        <Car size={17} aria-hidden="true" />
        <h3>{leave.leavingNow ? `Leaving now (${leave.time})` : `Leaving ${leave.time} ${leave.day}`}</h3>
        <span>your usual time</span>
      </header>
      <div className="departure-charge">
        <div className="departure-levels">
          <strong>{Math.round(now)}%</strong>
          {then !== now && <><span aria-hidden="true">→</span><strong>{then}%</strong><small>by {leave.time}</small></>}
          {leave.rangeAtDeparture !== null && <small className="departure-range">≈ {leave.rangeAtDeparture} mi electric</small>}
        </div>
        <span className="departure-bar" role="meter" aria-label="Battery now and at departure" aria-valuemin={0} aria-valuemax={100} aria-valuenow={then}>
          <span className="departure-bar-then" style={{ width: `${then}%` }} />
          <span className="departure-bar-now" style={{ width: `${Math.min(now, then)}%` }} />
        </span>
      </div>
      <p className="departure-status">
        {status.tone === 'warn' ? <Plug size={15} aria-hidden="true" /> : <BatteryCharging size={15} aria-hidden="true" />}
        {status.text}
      </p>
      {climate && (
        <div className="departure-climate">
          {climate === 'warm' ? <Flame size={16} aria-hidden="true" /> : <Snowflake size={16} aria-hidden="true" />}
          <span>Feels like {leave.feelsLike}{leave.temperatureUnit} at {leave.time}: {climate === 'warm' ? 'warm the car up first' : 'cool the car down first'}.</span>
          <button type="button" className={`glass-pill ${confirm.armed ? 'is-armed' : ''}`} onClick={() => void startClimate()} disabled={started === 'busy' || started === 'done'}>
            {started === 'done' ? 'Climate started' : started === 'busy' ? 'Starting…' : confirm.armed ? 'Tap again to start' : climate === 'warm' ? 'Warm up the car' : 'Cool down the car'}
          </button>
          {started === 'failed' && <small className="departure-error">The car did not respond. Try again in a minute.</small>}
        </div>
      )}
    </section>
  )
}
