import { useEffect, useState } from 'react'
import { cachedJson, isAbortError } from './cachedFetch'
import type { HAEntity } from './types'

export interface Advice {
  id: string
  window: 'today' | 'tonight' | 'tomorrow' | 'day2' | 'day3'
  when: string
  severity: 'critical' | 'warning' | 'info'
  kind: string
  title: string
  detail: string
}

export interface WatchFinding {
  rule: string
  category: string
  severity: 'critical' | 'warning' | 'info'
  entityId: string
  name: string
  seconds: number
  detail: string
}

export interface JournalEntry extends WatchFinding {
  startedAt: string
  endedAt: string | null
  ongoing: boolean
}

export interface WeeklyReport {
  headline: string
  stats: { key: string; label: string; value: number; previous: number; detail?: string }[]
  top: { name: string; count: number }[]
  days: number
}

export interface MorningBrief {
  today: {
    date: string
    high: string | null
    low: string | null
    weatherCode: number | null
    rainChance: number | null
    sunrise: string | null
    sunset: string | null
    daylightChange: string | null
  } | null
  advice: Advice[]
  days: { date: string; label: string; high: string | null; low: string | null; weatherCode: number | null; rainChance: number | null }[]
  forecastError: string | null
  findings: WatchFinding[]
  journal: JournalEntry[]
  recentActions: { entityId: string; name?: string; service: string; at: string }[]
  leftOn: string[]
  /** Watering advice from the plant sensors and the rain forecast. Absent from older backends. */
  garden?: Advice[]
  weekly?: WeeklyReport
}

/** Same rule as the Weather page: the outdoor sensor's unit decides °C or °F for the whole brief. */
export function preferredUnits(entities: Map<string, HAEntity>): 'metric' | 'imperial' {
  const outside = entities.get('sensor.open_weather_temperature')
    ?? Array.from(entities.values()).find((entity) => entity.attributes.device_class === 'temperature' && /outside|outdoor/i.test(String(entity.attributes.friendly_name ?? entity.entity_id)))
  return String(outside?.attributes.unit_of_measurement ?? '').includes('C') ? 'metric' : 'imperial'
}

/** The forecast changes slowly and the house half is cheap; a quarter hour keeps both fresh enough. */
const BRIEF_TTL_MS = 15 * 60_000

export function useMorningBrief(units: 'metric' | 'imperial', enabled = true) {
  const [brief, setBrief] = useState<MorningBrief | null>(null)
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const abort = new AbortController()
    const path = `insights/morning?units=${units}`
    const load = (force: boolean) => cachedJson<MorningBrief>(path, path, BRIEF_TTL_MS, { signal: abort.signal, force })
      .then((data) => { setBrief(data); setFailed(false) })
      .catch((error: unknown) => { if (!isAbortError(error)) setFailed(true) })
    load(reloadKey > 0)
    const timer = window.setInterval(() => load(true), BRIEF_TTL_MS)
    return () => { abort.abort(); window.clearInterval(timer) }
  }, [units, enabled, reloadKey])
  return { brief, failed, reload: () => setReloadKey((key) => key + 1) }
}

/** Warnings worth raising outside the morning page: today, tonight or tomorrow, warning or worse. */
export function headsUp(brief: MorningBrief | null): Advice[] {
  if (!brief) return []
  return brief.advice
    .filter((item) => item.severity !== 'info' && (item.window === 'today' || item.window === 'tonight' || item.window === 'tomorrow'))
    .slice(0, 2)
}
