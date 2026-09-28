import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent } from 'react'
import { Activity, History } from 'lucide-react'
import { isAbortError } from './cachedFetch'
import { ChartLegend } from './chartKit'
import { OTHER_COLOR, SERIES_MAX, seriesColor } from './chartTheme'
import type { LegendItem } from './chartKit'
import { fetchHistory, parseHistoryRecords } from './history'
import { EmptyState, LoadingState } from './ui/StateMessages'
import './StateTimeline.css'

const HISTORY_TTL_MS = 5 * 60_000

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

/** Hatched "no data" fill, so a gap in the recorder never reads as a real state. */
const UNKNOWN_FILL = 'repeating-linear-gradient(45deg, transparent 0 3px, rgba(255, 255, 255, .14) 3px 6px)'
/** The resting half of an on/off pair: a quiet fill, so the one series hue marks when it was active. */
const RESTING_FILL = 'rgba(255, 255, 255, .08)'

/**
 * One colour per raw state. An on/off-like pair (one active state, one resting state) is a single
 * series: the active state wears --chart-1 and the resting one a muted fill. Anything else is
 * categorical, coloured in a fixed alphabetical order of the raw state so a state keeps its colour
 * however long it lasted today; past six states the rest fold into "Other".
 */
function stateColors(segments: Segment[]) {
  const known = Array.from(new Set(segments.map((segment) => segment.state).filter((state) => !unknownStates.has(state)))).sort()
  const colors = new Map<string, string>()
  const active = known.filter((state) => activeStates.has(state))
  if (known.length === 1 || (known.length === 2 && active.length === 1)) {
    known.forEach((state) => colors.set(state, activeStates.has(state) ? seriesColor(0) : RESTING_FILL))
  } else {
    known.forEach((state, index) => colors.set(state, index < SERIES_MAX ? seriesColor(index) : OTHER_COLOR))
  }
  unknownStates.forEach((state) => colors.set(state, UNKNOWN_FILL))
  return { colors, overflow: known.length > SERIES_MAX }
}

function parseSegments(payload: unknown, windowStart: number, now: number): Segment[] {
  const entries = parseHistoryRecords(payload).sort((left, right) => left.time - right.time)
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
    const abort = new AbortController()
    const now = Date.now()
    fetchHistory(entityId, 24, HISTORY_TTL_MS, abort.signal)
      .then((payload) => {
        setSegments(parseSegments(payload, now - 24 * 3_600_000, now))
        setLoading(false)
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return
        setSegments([])
        setLoading(false)
      })
    return () => abort.abort()
  }, [entityId])

  const stripRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ segment: Segment; x: number } | null>(null)
  const changes = Math.max(0, segments.length - 1)
  const { colors, overflow } = stateColors(segments)
  const colorFor = (state: string) => colors.get(state) ?? OTHER_COLOR
  const labelFor = (state: string) => (unknownStates.has(state) ? 'No data' : formatState(state))

  // Legend entries are keyed by colour so the "Other" fold and the no-data hatch each appear once.
  const totals = new Map<string, { label: string; color: string; total: number }>()
  for (const segment of segments) {
    const color = colorFor(segment.state)
    const label = color === OTHER_COLOR && overflow ? 'Other' : labelFor(segment.state)
    const entry = totals.get(color) ?? { label, color, total: 0 }
    entry.total += segment.to - segment.from
    totals.set(color, entry)
  }
  const legend: LegendItem[] = Array.from(totals.values())
    .sort((left, right) => right.total - left.total)
    .map((entry) => ({ label: entry.label, color: entry.color, shape: 'bar', value: formatDuration(entry.total) }))

  // A tap or hover on the strip names the segment under the finger; segments can be a pixel wide,
  // so this looks up by position instead of giving each sliver its own target.
  function inspect(event: PointerEvent<HTMLDivElement>) {
    const strip = stripRef.current
    if (!strip || !segments.length) return
    const rect = strip.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    const start = segments[0].from
    const time = start + fraction * (segments[segments.length - 1].to - start)
    const segment = segments.find((item) => time >= item.from && time <= item.to) ?? segments[segments.length - 1]
    setHover({ segment, x: fraction * 100 })
  }

  return (
    <section className="state-timeline" aria-label="24 hour activity">
      <header>
        <div><History size={16} aria-hidden="true" /><h3>24-hour activity</h3></div>
        <span>{segments.length ? `${changes} change${changes === 1 ? '' : 's'}` : ''}</span>
      </header>
      {segments.length ? (
        <>
          <ChartLegend items={legend} className="timeline-legend" />
          <div className="timeline-stage" data-swipe-ignore onPointerMove={inspect} onPointerDown={inspect} onPointerLeave={() => setHover(null)}>
            <div
              ref={stripRef}
              className="timeline-strip glass-inset"
              role="img"
              aria-label={`State over the last 24 hours, currently ${formatState(currentState)}`}
            >
              {segments.map((segment) => (
                <span
                  key={segment.from}
                  className="timeline-segment"
                  style={{ flexGrow: Math.max(1, segment.to - segment.from), '--segment': colorFor(segment.state) } as CSSProperties}
                />
              ))}
            </div>
            {hover && (
              <div className="timeline-tooltip chart-tooltip glass-strong" style={{ left: `clamp(70px, ${hover.x}%, calc(100% - 70px))` }} aria-hidden="true">
                <p className="chart-tooltip-label">{formatClock(hover.segment.from)} – {formatClock(hover.segment.to)}</p>
                <ul>
                  <li>
                    <span className="chart-swatch" style={{ '--swatch': colorFor(hover.segment.state) } as CSSProperties} />
                    <span className="chart-tooltip-name">{labelFor(hover.segment.state)}</span>
                    <strong>{formatDuration(hover.segment.to - hover.segment.from)}</strong>
                  </li>
                </ul>
              </div>
            )}
          </div>
          <div className="timeline-scale" aria-hidden="true"><span>24 hr ago</span><span>12 hr</span><span>Now</span></div>
        </>
      ) : loading ? (
        <LoadingState size="compact" label="Loading activity" />
      ) : (
        <EmptyState size="compact" icon={<Activity />} title="No recorded activity" hint="The recorder has no state changes for this entity in the last 24 hours" />
      )}
    </section>
  )
}
