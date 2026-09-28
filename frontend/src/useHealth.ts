import { useEffect, useState } from 'react'
import { apiUrl, timeoutSignal } from './api'
import type { HealthResponse } from './types'

const POLL_MS = 30_000
const FETCH_TIMEOUT_MS = 15_000

export interface HealthState {
  /** The last `/api/health` the backend answered with; null until the first one lands. */
  health: HealthResponse | null
  /** Whether the *backend* answered at all on the last poll. Distinct from HA being connected. */
  reachable: boolean | null
}

/**
 * Live view of `/api/health`. It used to be read once at boot, so a bridge that lost Home
 * Assistant an hour later still reported "connected" until someone reloaded the wall tablet.
 */
export function useHealth(intervalMs = POLL_MS): HealthState {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [reachable, setReachable] = useState<boolean | null>(null)

  useEffect(() => {
    let stopped = false

    async function poll() {
      try {
        const response = await fetch(apiUrl('health'), { signal: timeoutSignal(FETCH_TIMEOUT_MS) })
        if (!response.ok) throw new Error(`Health check failed (${response.status})`)
        const data: HealthResponse = await response.json()
        if (stopped) return
        setHealth(data)
        setReachable(true)
      } catch {
        // The last known health stays on screen; `reachable` says how much to trust it.
        if (!stopped) setReachable(false)
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), intervalMs)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [intervalMs])

  return { health, reachable }
}
