import { cachedJson } from './cachedFetch'

/**
 * Home Assistant recorder history, as the backend relays it.
 *
 * `/api/history/<entity>` answers either with a flat list of state records or, as the recorder
 * itself does, with that list wrapped in an outer array (one per requested entity). Every chart
 * used to carry its own copy of the unwrap-and-parse loop; this is the one copy.
 */
export interface HistoryPoint {
  time: number
  value: number
}

export interface HistoryRecord {
  state: string
  time: number
}

/** Relative API path for an entity's history, in one shape so equal requests share a cache entry. */
export function historyPath(entityId: string, hours = 24) {
  return `history/${entityId}?hours=${hours}`
}

/** Fetches (or reuses) the raw history payload for an entity. Errors propagate; nothing is cached on failure. */
export function fetchHistory(entityId: string, hours: number, ttlMs: number, signal?: AbortSignal): Promise<unknown> {
  const path = historyPath(entityId, hours)
  return cachedJson<unknown>(path, path, ttlMs, { signal })
}

/** The state records inside a history payload, whatever nesting the backend used. */
export function unwrapHistoryPayload(payload: unknown): Record<string, unknown>[] {
  if (!Array.isArray(payload)) return []
  const states: unknown[] = Array.isArray(payload[0]) ? payload[0] : payload
  return states.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
}

function recordTime(record: Record<string, unknown>) {
  return Date.parse(String(record.last_changed ?? record.last_updated ?? ''))
}

/** Every record with a parsable timestamp, state kept as text. For on/off timelines. */
export function parseHistoryRecords(payload: unknown): HistoryRecord[] {
  return unwrapHistoryPayload(payload).flatMap((record): HistoryRecord[] => {
    const time = recordTime(record)
    return Number.isFinite(time) ? [{ state: String(record.state ?? ''), time }] : []
  })
}

/** Numeric samples only, in recorder order. `unknown`/`unavailable` and blank states are skipped. */
export function parseHistoryStates(payload: unknown): HistoryPoint[] {
  return unwrapHistoryPayload(payload).flatMap((record): HistoryPoint[] => {
    const raw = record.state
    if (raw === '' || raw === null || raw === undefined) return []
    const value = Number(raw)
    const time = recordTime(record)
    return Number.isFinite(value) && Number.isFinite(time) ? [{ time, value }] : []
  })
}

/** Keeps at most `maximum` evenly spaced points plus the last one, so a chart never draws thousands of nodes. */
export function downsample<T>(points: T[], maximum: number): T[] {
  const step = Math.max(1, Math.ceil(points.length / maximum))
  return points.filter((_, index) => index % step === 0 || index === points.length - 1)
}
