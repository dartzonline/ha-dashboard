import { useEffect, useState } from 'react'
import { Activity, History } from 'lucide-react'
import { apiUrl } from './api'
import './StateTimeline.css'

interface StateTimelineProps {
  entityId: string
  currentState: string
  formatState: (state: string) => string
}

interface Segment {
  state: string
  from: number
  to: number
}

const activeStates = new Set([
  'on', 'open', 'opening', 'unlocked', 'playing', 'paused', 'cleaning', 'returning',
  'heat', 'cool', 'heat_cool', 'heating', 'cooling', 'drying', 'fan_only', 'home', 'running',
])
const unknownStates = new Set(['unavailable', 'unknown', ''])

function segmentTone(state: string) {
  if (unknownStates.has(state)) return 'unknown'
  return activeStates.has(state) ? 'active' : 'inactive'
}

function parseSegments(payload: unknown, windowStart: number, now: number): Segment[] {
  if (!Array.isArray(payload)) return []
  const states = Array.isArray(payload[0]) ? payload[0] : payload
  const entries = states
    .flatMap((item): { state: string; time: number }[] => {
      if (!item || typeof item !== 'object') return []
      const record = item as Record<string, unknown>
      const time = Date.parse(String(record.last_changed ?? record.last_updated ?? ''))
      return Number.isFinite(time) ? [{ state: String(record.state ?? ''), time }] : []
    })
    .sort((left, right) => left.time - right.time)
  if (!entries.length) return []

  const segments: Segment[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const from = Math.max(entries[index].time, windowStart)
    const to = index + 1 < entries.length ? entries[index + 1].time : now
    if (to <= from) continue
    const state = entries[index].state
    const previous = segments[segments.length - 1]
    if (previous && previous.state === state) {
      previous.to = to
    } else {
      segments.push({ state, from, to })
    }
  }
  return segments
}

function formatClock(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatDuration(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60_000)
  if (minutes < 1) return '<1 min'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

/** 24-hour on/off strip for entities whose history is discrete rather than numeric. */
export function StateTimeline({ entityId, currentState, formatState }: StateTimelineProps) {
  const [segments, setSegments] = useState<Segment[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let stopped = false
    const now = Date.now()
    fetch(apiUrl(`history/${entityId}`))
      .then((response) => (response.ok ? response.json() : []))
      .then((payload) => {
        if (!stopped) setSegments(parseSegments(payload, now - 24 * 3_600_000, now))
      })
      .catch(() => {
        if (!stopped) setSegments([])
      })
      .finally(() => {
        if (!stopped) setLoading(false)
      })
    return () => { stopped = true }
  }, [entityId])

  const changes = Math.max(0, segments.length - 1)
  const totals = new Map<string, number>()
  for (const segment of segments) {
    const tone = segmentTone(segment.state)
    if (tone === 'unknown') continue
    const key = formatState(segment.state)
    totals.set(key, (totals.get(key) ?? 0) + (segment.to - segment.from))
  }
  const legend = Array.from(totals.entries()).sort((left, right) => right[1] - left[1]).slice(0, 4)
  const legendTone = (label: string) => {
    const match = segments.find((segment) => formatState(segment.state) === label)
    return match ? segmentTone(match.state) : 'inactive'
  }

  return (
    <section className="state-timeline" aria-label="24 hour activity">
      <header>
        <div><History size={17} /><h3>24-hour activity</h3></div>
        <span>{segments.length ? `${changes} change${changes === 1 ? '' : 's'}` : ''}</span>
      </header>
      {segments.length ? (
        <>
          <div className="timeline-strip" role="img" aria-label={`State over the last 24 hours, currently ${formatState(currentState)}`}>
            {segments.map((segment) => (
              <span
                key={segment.from}
                className={`timeline-segment tone-${segmentTone(segment.state)}`}
                style={{ flexGrow: Math.max(1, segment.to - segment.from) }}
                title={`${formatState(segment.state)} · ${formatClock(segment.from)} – ${formatClock(segment.to)}`}
              />
            ))}
          </div>
          <div className="timeline-scale"><span>24 hr ago</span><span>12 hr</span><span>Now</span></div>
          <div className="timeline-legend">
            {legend.map(([label, total]) => (
              <span key={label} className="timeline-chip">
                <i className={`tone-${legendTone(label)}`} />
                <strong>{label}</strong>
                <em>{formatDuration(total)}</em>
              </span>
            ))}
          </div>
        </>
      ) : (
        <div className={`timeline-empty ${loading ? 'loading' : ''}`}>
          <Activity size={20} />
          <span>{loading ? 'Loading activity' : 'No recorded activity in the last 24 hours'}</span>
        </div>
      )}
    </section>
  )
}
