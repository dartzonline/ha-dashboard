import { useEffect, useState } from 'react'
import { peekCached } from './cachedFetch'
import { downsample, fetchHistory, historyPath, parseHistoryStates } from './history'
import type { SparkPoint } from './Sparkline'

/** Tiles re-mount every section rotation, so 24-hour trends come from the shared history cache. */
const CACHE_TTL_MS = 10 * 60_000
const MAX_POINTS = 48

function toSparkPoints(payload: unknown): SparkPoint[] {
  return downsample(parseHistoryStates(payload), MAX_POINTS)
}

export function useSparkline(entityId: string, enabled: boolean) {
  const [points, setPoints] = useState<SparkPoint[]>(() => {
    const cached = peekCached<unknown>(historyPath(entityId))
    return cached === undefined ? [] : toSparkPoints(cached)
  })

  useEffect(() => {
    if (!enabled) return
    let stopped = false
    fetchHistory(entityId, 24, CACHE_TTL_MS)
      .then((payload) => {
        if (!stopped) setPoints(toSparkPoints(payload))
      })
      .catch(() => {
        // Nothing is cached on failure, so the next mount (next rotation) retries; the tile keeps
        // whatever trend it last drew rather than blanking.
      })
    return () => { stopped = true }
  }, [entityId, enabled])

  return points
}
