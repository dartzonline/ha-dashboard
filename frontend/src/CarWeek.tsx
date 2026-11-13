import { useEffect, useState } from 'react'
import { BatteryCharging, Fuel, PlugZap, Zap } from 'lucide-react'
import { cachedJson, isAbortError } from './cachedFetch'
import { fullChargeHours, windowLabel, type CarWeekData } from './carRoomsFormat'
import './CarWeek.css'

const CAR_PATH = 'insights/car?days=7'
const CAR_TTL_MS = 30 * 60_000

const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(/\s/g, ' ')
}

function day(iso: string) {
  return new Date(iso).toLocaleDateString([], { weekday: 'short' })
}

export function CarWeekPanel() {
  const [data, setData] = useState<CarWeekData | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const abort = new AbortController()
    cachedJson<CarWeekData>(CAR_PATH, CAR_PATH, CAR_TTL_MS, { signal: abort.signal })
      .then((value) => {
        if (typeof value?.available !== 'boolean') throw new Error('Unexpected car response')
        setData(value)
        setFailed(false)
      })
      .catch((error: unknown) => { if (!isAbortError(error)) setFailed(true) })
    return () => abort.abort()
  }, [])

  if (failed || (data && !data.available)) return null

  const share = data?.electricShare ?? null
  const hours = data ? fullChargeHours(data) : null
  const sessions = [...(data?.sessions ?? [])].reverse().slice(0, 5)

  return (
    <section className="volvo-panel glass glass-card car-week" aria-label="Charging this week">
      <header className="volvo-card-head">
        <BatteryCharging size={15} aria-hidden="true" />
        <h3>Charging &amp; electric driving</h3>
        {data && <span>{windowLabel(data)}</span>}
      </header>
      {!data ? <p className="car-week-note">Adding up the week…</p> : (
        <>
          <div className="car-week-stats">
            <div>
              <em><PlugZap size={13} aria-hidden="true" />Charged</em>
              <b>{data.charges} {data.charges === 1 ? 'time' : 'times'}</b>
              <small>about {data.kwh} kWh</small>
            </div>
            <div>
              <em><Zap size={13} aria-hidden="true" />Cost</em>
              <b>{money.format(data.cost ?? 0)}</b>
              <small>{data.fullChargeCost ? `a full charge ≈ ${money.format(data.fullChargeCost)}` : `at ${((data.rate ?? 0) * 100).toFixed(1)}¢/kWh`}</small>
            </div>
            <div>
              <em><BatteryCharging size={13} aria-hidden="true" />Electric</em>
              <b>{share !== null ? `${Math.round(share * 100)}%` : '—'}</b>
              <small>{share !== null ? `${Math.round(data.electricMiles ?? 0)} of ${Math.round(data.miles ?? 0)} mi` : data.miles ? `${Math.round(data.miles)} mi driven` : 'no driving yet'}</small>
              {share !== null && (
                <span className="car-week-meter" role="meter" aria-label="Share of miles driven on electricity" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
                  <span style={{ width: `${Math.round(share * 100)}%` }} />
                </span>
              )}
            </div>
            <div>
              <em><Fuel size={13} aria-hidden="true" />Gas</em>
              <b>{(data.gallons ?? 0).toFixed(1)} gal</b>
              <small>{data.gasMpg ? `${data.gasMpg} mpg on gas` : 'fuel used'}</small>
            </div>
          </div>
          {data.typicalKw && (
            <p className="car-week-note">
              Charges at about {data.typicalKw.toFixed(1)} kW{data.level1 ? ', a standard wall outlet' : ''}
              {hours ? `: empty to full takes about ${Math.round(hours)} hours` : ''}.
            </p>
          )}
          {sessions.length > 0 && (
            <ul className="car-week-sessions">
              {sessions.map((session) => (
                <li key={session.start}>
                  <span>{day(session.start)} {clock(session.start)} → {clock(session.end)}</span>
                  <span>{Math.round(session.fromPct)}% → {Math.round(session.toPct)}%</span>
                  <span>{session.kwh.toFixed(1)} kWh</span>
                  <strong>{money.format(session.cost)}</strong>
                </li>
              ))}
            </ul>
          )}
          <p className="car-week-foot">Worked out from the battery level, at your electricity rate. Charging away from home is counted the same way.</p>
        </>
      )}
    </section>
  )
}
