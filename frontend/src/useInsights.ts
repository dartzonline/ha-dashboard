import { useEffect, useRef, useState } from 'react'
import { apiUrl } from './api'

/** Insights re-enters this hook every time the section is revisited during rotation; skip refetching the recorder within this window. */
const CACHE_TTL_MS = 5 * 60_000

export interface HistoryPoint {
  time: number
  value: number
}

export interface InsightSeries {
  entityId: string
  points: HistoryPoint[]
}

interface InsightRequest {
  entityId: string
  hours: number
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
  { entityId: 'sensor.cbr750_gateway_download_speed', hours: 24 },
  { entityId: 'sensor.cbr750_gateway_upload_speed', hours: 24 },
  { entityId: 'sensor.esphome_web_79cc76_salt_level_percent', hours: 24 * 30 },
  { entityId: 'sensor.lawn_plant_sensor_maple_humidity', hours: 24 * 7 },
  { entityId: 'sensor.lawn_plant_sensor_magnolia_humidity', hours: 24 * 7 },
]

function parseHistory(payload: unknown, entityId: string): HistoryPoint[] {
  if (!Array.isArray(payload)) return []
  const states = Array.isArray(payload[0]) ? payload[0] : payload
  return states.flatMap((item): HistoryPoint[] => {
    if (!item || typeof item !== 'object') return []
    const state = item as Record<string, unknown>
    const rawValue = Number(state.state)
    const isGatewayRate = entityId === 'sensor.cbr750_gateway_download_speed' || entityId === 'sensor.cbr750_gateway_upload_speed'
    const value = isGatewayRate ? rawValue * 8 / 1024 : rawValue
    const changed = String(state.last_changed ?? state.last_updated ?? '')
    const time = Date.parse(changed)
    return Number.isFinite(value) && Number.isFinite(time) ? [{ time, value }] : []
  })
}

export function useInsights(enabled: boolean) {
  const [series, setSeries] = useState<Map<string, HistoryPoint[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const lastFetchedAt = useRef(0)

  useEffect(() => {
    if (!enabled) return
    if (lastFetchedAt.current && Date.now() - lastFetchedAt.current < CACHE_TTL_MS) return
    let stopped = false
    const controller = new AbortController()
    queueMicrotask(() => {
      if (!stopped) setLoading(true)
    })

    Promise.all(insightEntities.map(async ({ entityId, hours }): Promise<InsightSeries> => {
      try {
        const response = await fetch(apiUrl(`history/${entityId}?hours=${hours}`), { signal: controller.signal })
        if (!response.ok) return { entityId, points: [] }
        return { entityId, points: parseHistory(await response.json(), entityId) }
      } catch {
        return { entityId, points: [] }
      }
    }))
      .then((results) => {
        if (!stopped) {
          setSeries(new Map(results.map((result) => [result.entityId, result.points])))
          lastFetchedAt.current = Date.now()
        }
      })
      .finally(() => {
        if (!stopped) setLoading(false)
      })

    return () => {
      stopped = true
      controller.abort()
    }
  }, [enabled])

  return { series, loading }
}
