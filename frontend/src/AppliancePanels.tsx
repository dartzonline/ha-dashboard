import { useEffect, useState } from 'react'
import { AirVent, Refrigerator } from 'lucide-react'
import { cachedJson, invalidate } from './cachedFetch'
import { apiUrl, responseError } from './api'
import {
  FRIDGE_STATUS, efficiencyLabel, filterLabel, percentChange, weekdayShort, type FridgeTrend, type HvacReport,
} from './applianceFormat'
import { useTwoTapConfirm } from './ui/useTwoTapConfirm'
import './AppliancePanels.css'

const FRIDGE_PATH = 'insights/fridge'
const HVAC_PATH = 'insights/hvac'
const TTL_MS = 30 * 60_000

function useInsight<T extends { available: boolean }>(path: string) {
  const [data, setData] = useState<T | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    cachedJson<T>(path, path, TTL_MS, { signal: abort.signal })
      .then((value) => { if (typeof value?.available === 'boolean') setData(value) })
      .catch(() => undefined)
    return () => abort.abort()
  }, [path])
  return [data, setData] as const
}

/** Weekly kWh/day as a line, so a slow climb shows at a glance. */
function WeekLine({ weeks }: { weeks: { weekEnding: string; kwhPerDay: number }[] }) {
  if (weeks.length < 3) return null
  const values = weeks.map((week) => week.kwhPerDay)
  const low = Math.min(...values) * 0.95
  const high = Math.max(...values) * 1.05
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${30 - ((value - low) / (high - low || 1)) * 30}`).join(' ')
  return (
    <svg className="appliance-line" viewBox="0 0 100 30" preserveAspectRatio="none" role="img"
      aria-label={`Weekly average from ${values[0]} to ${values[values.length - 1]} kWh a day`}>
      <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function FridgePanel() {
  const [data] = useInsight<FridgeTrend>(FRIDGE_PATH)
  if (!data?.available || !data.status) return null
  const tone = data.status === 'high' ? 'is-warning' : data.status === 'watch' ? 'is-watch' : ''
  return (
    <section className={`maint-panel glass appliance-panel ${tone}`.trim()} aria-label="Fridge efficiency">
      <header className="maint-panel-head">
        <h3><Refrigerator size={14} aria-hidden="true" />Fridge efficiency</h3>
        <span className="appliance-chip">{FRIDGE_STATUS[data.status]}</span>
      </header>
      <dl className="maint-rows">
        <dt>Last 2 weeks</dt>
        <dd>{data.recentKwhPerDay ?? '—'} kWh/day</dd>
        <dt>Usually</dt>
        <dd>{data.usualKwhPerDay !== null && data.usualKwhPerDay !== undefined ? `${data.usualKwhPerDay} kWh/day` : 'learning'}{percentChange(data.rise) ? ` (${percentChange(data.rise)})` : ''}</dd>
        {data.yearlyCost !== null && data.yearlyCost !== undefined && <><dt>A year at this rate</dt><dd>≈ ${data.yearlyCost}</dd></>}
      </dl>
      {data.weeks && <WeekLine weeks={data.weeks} />}
      {data.advice && data.advice.length > 0 && <ul className="appliance-advice">{data.advice.map((line) => <li key={line}>{line}</li>)}</ul>}
    </section>
  )
}

export function HvacPanel() {
  const [data, setData] = useInsight<HvacReport>(HVAC_PATH)
  const confirm = useTwoTapConfirm()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!data?.available) return null

  async function filterChanged() {
    if (!confirm.request()) return
    setSaving(true)
    setError(null)
    try {
      const today = new Date()
      const changedOn = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      const response = await fetch(apiUrl('maintenance/hvac-filter'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changedOn }),
      })
      if (!response.ok) throw await responseError(response, 'Could not save the filter date')
      const body = await response.json() as { filter: HvacReport['filter'] }
      invalidate(HVAC_PATH)
      setData((current) => current ? { ...current, filter: body.filter, advice: (current.advice ?? []).filter((line) => !line.startsWith('The filter')) } : current)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const days = data.days ?? []
  const most = Math.max(1, ...days.map((day) => day.hours))
  const filter = data.filter
  const warn = data.efficiency?.status === 'longer' || data.shortCycling || filter?.status === 'due'
  return (
    <section className={`maint-panel glass appliance-panel ${warn ? 'is-warning' : ''}`.trim()} aria-label="Heating and cooling">
      <header className="maint-panel-head">
        <h3><AirVent size={14} aria-hidden="true" />Heating &amp; cooling</h3>
        <span>{data.avgHoursPerDay !== null && data.avgHoursPerDay !== undefined ? `${data.avgHoursPerDay} h a day` : 'learning'}</span>
      </header>
      {days.length > 0 && (
        <div className="hvac-days" role="img" aria-label={`Run time over the last ${days.length} days`}>
          {days.map((day) => (
            <div key={day.date} className={`hvac-day is-${day.mode ?? 'off'}`}>
              <small>{day.hours.toFixed(1)}h</small>
              <span style={{ height: `${Math.max(3, (day.hours / most) * 100)}%` }} />
              <em>{weekdayShort(day.date)}</em>
              {day.outdoorF !== null && <small>{Math.round(day.outdoorF)}°</small>}
            </div>
          ))}
        </div>
      )}
      <dl className="maint-rows">
        <dt>This week</dt>
        <dd>{data.weekHours ?? 0} h{data.cycleMinutes ? ` · ${Math.round(data.cycleMinutes)} min a run` : ''}</dd>
        <dt>Same weather</dt>
        <dd className={data.efficiency?.status === 'longer' ? 'is-bad' : ''}>{efficiencyLabel(data.efficiency)}</dd>
        <dt>Filter</dt>
        <dd className={filter?.status === 'due' ? 'is-bad' : ''}>{filterLabel(filter)}</dd>
      </dl>
      {data.advice && data.advice.length > 0 && <ul className="appliance-advice">{data.advice.map((line) => <li key={line}>{line}</li>)}</ul>}
      <div className="appliance-actions">
        <button type="button" className={`glass-pill ${confirm.armed ? 'is-armed' : ''}`} onClick={() => void filterChanged()} disabled={saving || filter?.days === 0}>
          {filter?.days === 0 ? 'Filter changed today' : saving ? 'Saving…' : confirm.armed ? 'Tap again to confirm' : 'I changed the filter today'}
        </button>
        {error && <small className="appliance-error">{error}</small>}
      </div>
    </section>
  )
}
