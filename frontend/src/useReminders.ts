import { useCallback, useEffect, useState } from 'react'
import { apiUrl, responseError } from './api'

export interface BinStatus {
  enabled: boolean
  pickupDate: string
  pickupLabel: string
  kinds: ('trash' | 'recycling')[]
  done: boolean
  /** 'evening' the night before pickup, inside the reminder window; 'morning' on pickup day before 10 am. */
  phase: 'evening' | 'morning' | null
  /** Which reminder slot of the evening this is; a new slot is a new nudge. */
  slot: number | null
  title: string | null
  message: string | null
}

const POLL_MS = 60_000

/** Bin night, from the backend, which knows the house's own time zone. Polled each minute. */
export function useReminders(enabled = true) {
  const [bins, setBins] = useState<BinStatus | null>(null)
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(apiUrl('reminders'), { signal })
      if (!response.ok) return
      const data = await response.json() as { bins: BinStatus }
      setBins(data.bins)
    } catch {
      // Offline for a minute: keep the last status and try again on the next poll.
    }
  }, [])
  useEffect(() => {
    if (!enabled) return
    const abort = new AbortController()
    void load(abort.signal)
    const timer = window.setInterval(() => void load(abort.signal), POLL_MS)
    return () => { abort.abort(); window.clearInterval(timer) }
  }, [enabled, load])

  const markBinsOut = useCallback(async (pickupDate: string | null) => {
    const response = await fetch(apiUrl('reminders/bins/done'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pickupDate }),
    })
    if (!response.ok) throw await responseError(response, 'Could not save')
    const data = await response.json() as { bins: BinStatus }
    setBins(data.bins)
  }, [])
  return { bins, markBinsOut }
}
