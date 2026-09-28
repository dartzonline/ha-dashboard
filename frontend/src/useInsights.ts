import { useEffect, useState } from 'react'
import { fetchHistory, parseHistoryStates } from './history'
import type { HistoryPoint } from './history'
import { toMbps } from './units'

/** Insights re-enters this hook every time the section is revisited during rotation; the shared history cache answers within this window. */
const CACHE_TTL_MS = 5 * 60_000
/** After a partial failure (recorder busy, backend restarting) try again well before the cache would. */
const RETRY_MS = 30_000

export type { HistoryPoint }

export interface InsightSeries {
  entityId: string
  points: HistoryPoint[]
}

interface InsightRequest {
  entityId: string
  hours: number
  /** Recorder unit, when the raw value needs converting for the chart. */
  unit?: string
}

const insightEntities: InsightRequest[] = [
  { entityId: 'sensor.main_floor_temperature', hours: 24 },
  { entityId: 'sensor.nursery_sensor_temperature', hours: 24 },
  { entityId: 'sensor.master_bedroom_master_bedroom_temperature_temperature', hours: 24 },
  { entityId: 'sensor.office_temperature_temperature_2', hours: 24 },
  { entityId: 'sensor.media_sensor_temperature', hours: 24 },
  { entityId: 'sensor.attic_sensor_temperature', hours: 24 },
  { entityId: 'sensor.guest_bedroom_sensor_temperature', hours: 24 },
  { entityId: 'sensor.open_weather_temperature', hours: 24 },
  { entityId: 'sensor.cbr750_gateway_download_speed', hours: 24, unit: 'KiB/s' },
  { entityId: 'sensor.cbr750_gateway_upload_speed', hours: 24, unit: 'KiB/s' },
  { entityId: 'sensor.esphome_web_79cc76_salt_level_percent', hours: 24 * 30 },
  { entityId: 'sensor.lawn_plant_sensor_maple_humidity', hours: 24 * 7 },
  { entityId: 'sensor.lawn_plant_sensor_magnolia_humidity', hours: 24 * 7 },
]

function parseSeries(payload: unknown, unit: string | undefined): HistoryPoint[] {
  const points = parseHistoryStates(payload)
  return unit ? points.map((point) => ({ time: point.time, value: toMbps(point.value, unit) })) : points
}

export function useInsights(enabled: boolean) {
  const [series, setSeries] = useState<Map<string, HistoryPoint[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let retryTimer: number | undefined
    const controller = new AbortController()

    async function load() {
      const results = await Promise.all(insightEntities.map(async ({ entityId, hours, unit }) => {
        try {
          const payload = await fetchHistory(entityId, hours, CACHE_TTL_MS, controller.signal)
          return { entityId, points: parseSeries(payload, unit), ok: true }
        } catch {
          return { entityId, points: [] as HistoryPoint[], ok: false }
        }
      }))
      if (stopped) return
      // Failed series keep whatever the previous load had rather than flattening to nothing.
      setSeries((previous) => {
        const next = new Map(previous)
        for (const result of results) {
          if (result.ok || !next.has(result.entityId)) next.set(result.entityId, result.points)
        }
        return next
      })
      const failed = results.filter((result) => !result.ok).length
      setError(failed ? `${failed} of ${results.length} histories unavailable` : null)
      setLoading(false)
      if (failed) retryTimer = window.setTimeout(() => void load(), RETRY_MS)
    }

    void load()
    // Insights can sit on screen for a minute at a time, many times an hour; a refresh on the
    // cache's own cadence keeps a long-open page from freezing at its first load.
    const timer = window.setInterval(() => void load(), CACHE_TTL_MS)
    return () => {
      stopped = true
      controller.abort()
      window.clearInterval(timer)
      if (retryTimer) window.clearTimeout(retryTimer)
    }
  }, [enabled])

  return { series, loading, error }
}
