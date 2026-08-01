import { useCallback, useState } from 'react'

export interface LogEntry {
  id: number
  title: string
  message: string
  tone: 'info' | 'warning' | 'success'
  at: number
}

interface IncomingAlert {
  id: number
  title: string
  message: string
  tone: 'info' | 'warning' | 'success'
}

const MAX_ENTRIES = 200

export function useEventLog() {
  const [events, setEvents] = useState<LogEntry[]>([])

  const addEvent = useCallback((alert: IncomingAlert) => {
    setEvents((prev) => {
      // Guards against the same alert id being logged twice (e.g. a re-render
      // replaying the parent's callback with an alert already recorded).
      if (prev.some((entry) => entry.id === alert.id)) return prev

      const next = [{ ...alert, at: Date.now() }, ...prev]
      if (next.length > MAX_ENTRIES) {
        next.length = MAX_ENTRIES
      }
      return next
    })
  }, [])

  return { events, addEvent }
}
