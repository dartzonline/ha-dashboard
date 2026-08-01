import { X } from 'lucide-react'
import type { LogEntry } from './useEventLog'
import './EventLog.css'

interface EventLogProps {
  events: LogEntry[]
  onClose: () => void
}

interface DayGroup {
  label: string
  entries: LogEntry[]
}

function dayLabel(at: number): string {
  const date = new Date(at)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

  if (isSameDay(date, today)) return 'Today'
  if (isSameDay(date, yesterday)) return 'Yesterday'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}

function groupByDay(events: LogEntry[]): DayGroup[] {
  const groups: DayGroup[] = []
  for (const entry of events) {
    const label = dayLabel(entry.at)
    const current = groups[groups.length - 1]
    if (current && current.label === label) {
      current.entries.push(entry)
    } else {
      groups.push({ label, entries: [entry] })
    }
  }
  return groups
}

export function EventLog({ events, onClose }: EventLogProps) {
  const groups = groupByDay(events)

  return (
    <div className="event-log-backdrop" onClick={onClose}>
      <aside className="event-log-drawer" onClick={(event) => event.stopPropagation()}>
        <header className="event-log-header">
          <div>
            <h2>Activity</h2>
            <span>{events.length} {events.length === 1 ? 'event' : 'events'}</span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close activity log">
            <X size={18} />
          </button>
        </header>
        <div className="event-log-body">
          {events.length === 0 ? (
            <div className="event-log-empty">
              <p>No activity yet.</p>
            </div>
          ) : (
            groups.map((group) => (
              <section className="event-log-group" key={group.label}>
                <h3>{group.label}</h3>
                <ul>
                  {group.entries.map((entry) => (
                    <li className={`event-log-row tone-${entry.tone}`} key={entry.id}>
                      <i />
                      <div className="event-log-row-main">
                        <div className="event-log-row-top">
                          <strong>{entry.title}</strong>
                          <time>{timeLabel(entry.at)}</time>
                        </div>
                        <span>{entry.message}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </aside>
    </div>
  )
}
