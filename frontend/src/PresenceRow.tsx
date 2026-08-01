import type { HAEntity } from './types'
import './PresenceRow.css'

function friendlyName(entity: HAEntity) {
  const name = entity.attributes.friendly_name
  return typeof name === 'string' && name.trim() ? name.trim() : entity.entity_id.split('.').slice(1).join('.')
}

function initials(name: string) {
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0] + parts[parts.length - 1]![0]).toUpperCase()
}

function zoneLabel(state: string) {
  if (state === 'home') return 'Home'
  if (state === 'not_home') return 'Away'
  return state.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function relativeTime(iso: string) {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const diffMinutes = Math.round((Date.now() - then) / 60_000)
  if (diffMinutes < 1) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  if (diffMinutes < 60 * 24) {
    return `since ${new Date(then).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  }
  return `since ${new Date(then).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
}

export function PresenceRow({ entities }: { entities: Map<string, HAEntity> }) {
  const people = [...entities.values()]
    .filter((entity) => entity.entity_id.startsWith('person.'))
    .sort((a, b) => friendlyName(a).localeCompare(friendlyName(b)))

  if (people.length === 0) return null

  return (
    <div className="presence-row" role="list" aria-label="Household presence">
      {people.map((entity) => {
        const name = friendlyName(entity)
        const isAway = entity.state === 'not_home'
        return (
          <div key={entity.entity_id} role="listitem" className={`presence-chip ${isAway ? 'is-away' : 'is-home'}`}>
            <span className="presence-avatar" aria-hidden="true">{initials(name)}</span>
            <span className="presence-copy">
              <strong>{name}</strong>
              <small>{isAway ? `Away · ${relativeTime(entity.last_changed)}` : zoneLabel(entity.state)}</small>
            </span>
          </div>
        )
      })}
    </div>
  )
}
