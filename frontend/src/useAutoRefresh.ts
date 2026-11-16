import { useEffect, useRef } from 'react'
import { scriptHeapBytes, shouldRefresh } from './autoRefresh'

const CHECK_EVERY_MS = 60_000

/** Quietly reloads the page overnight (or if memory ever climbs), only while nothing is open. */
export function useAutoRefresh(idle: boolean, reload: () => void = () => window.location.reload()) {
  const idleRef = useRef(idle)
  const reloadRef = useRef(reload)
  useEffect(() => { idleRef.current = idle; reloadRef.current = reload })

  useEffect(() => {
    const loadedAt = Date.now()
    const timer = window.setInterval(() => {
      const now = new Date()
      if (shouldRefresh({ ageMs: now.getTime() - loadedAt, hour: now.getHours(), heapBytes: scriptHeapBytes(), idle: idleRef.current })) {
        window.clearInterval(timer)
        reloadRef.current()
      }
    }, CHECK_EVERY_MS)
    return () => window.clearInterval(timer)
  }, [])
}
