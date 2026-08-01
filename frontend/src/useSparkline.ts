import { useEffect, useState } from 'react'
import { apiUrl } from './api'
import type { SparkPoint } from './Sparkline'

/** Tiles re-mount every section rotation, so 24-hour trends are cached module-wide with in-flight dedupe. */
const cache = new Map<string, { points: SparkPoint[]; fetchedAt: number }>()
const inflight = new Map<string, Promise<SparkPoint[]>>()
const CACHE_TTL_MS = 10 * 60_000

function parseHistory(payload: unknown): SparkPoint[] {
  if (!Array.isArray(payload)) return []
  const states = Array.isArray(payload[0]) ? payload[0] : payload
  const points = states.flatMap((item): SparkPoint[] => {
    if (!item || typeof item !== 'object') return []
    const state = item as Record<string, unknown>
    const value = Number(state.state)
    const time = Date.parse(String(state.last_changed ?? state.last_updated ?? ''))
    return Number.isFinite(value) && Number.isFinite(time) ? [{ time, value }] : []
  })
  const step = Math.max(1, Math.ceil(points.length / 48))
  return points.filter((_, index) => index % step === 0 || index === points.length - 1)
}

function fetchSparkline(entityId: string): Promise<SparkPoint[]> {
  const cached = cache.get(entityId)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cached.points)
  const pending = inflight.get(entityId)
  if (pending) return pending
  const request = fetch(apiUrl(`history/${entityId}`))
    .then((response) => (response.ok ? response.json() : []))
    .then((payload) => {
      const points = parseHistory(payload)
      cache.set(entityId, { points, fetchedAt: Date.now() })
      return points
    })
    .catch(() => [] as SparkPoint[])
    .finally(() => { inflight.delete(entityId) })
  inflight.set(entityId, request)
  return request
}

export function useSparkline(entityId: string, enabled: boolean) {
  const [points, setPoints] = useState<SparkPoint[]>(() => cache.get(entityId)?.points ?? [])

  useEffect(() => {
    if (!enabled) return
    let stopped = false
    void fetchSparkline(entityId).then((result) => {
      if (!stopped) setPoints(result)
    })
    return () => { stopped = true }
  }, [entityId, enabled])

  return points
}
