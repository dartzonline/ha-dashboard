import { ArrowRight, DoorOpen, Droplets, Lock, ShieldCheck, Warehouse, Wrench, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { HAEntity, TileConfig } from './types'
import './SecurityPanel.css'

interface SecurityPanelProps {
  entities: Map<string, HAEntity>
  onInspect: (tile: TileConfig) => void
  onOpenSection: () => void
  onClose: () => void
  now: Date
}

interface SecurityItem {
  entityId: string
  name: string
  state: string
  since: string
  icon: string
  inspectable?: boolean
}

interface SecurityGroup {
  id: string
  title: string
  icon: LucideIcon
  tone: 'danger' | 'warn'
  items: SecurityItem[]
}

const openDoorClasses = ['door', 'garage_door', 'window', 'opening']

function friendlyName(entity: HAEntity) {
  return String(entity.attributes.friendly_name ?? entity.entity_id.split('.')[1].replaceAll('_', ' '))
}

function deviceClass(entity: HAEntity) {
  return String(entity.attributes.device_class ?? '')
}

function matchesDoorSignal(entity: HAEntity) {
  const klass = deviceClass(entity)
  if (openDoorClasses.includes(klass)) return true
  const searchable = `${entity.entity_id} ${friendlyName(entity)}`.toLowerCase()
  if (/gateway/.test(searchable)) return false
  return /\bdoor\b|\bwindow\b|\bgarage\b|\bgate\b|\bentry\b/.test(searchable)
}

/** "Open for 12 minutes" is more actionable on a wall panel than a raw timestamp. */
function elapsed(entity: HAEntity, now: Date) {
  const changed = Date.parse(entity.last_changed)
  if (!Number.isFinite(changed)) return 'Unknown duration'
  const minutes = Math.max(0, Math.round((now.getTime() - changed) / 60_000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ${minutes % 60} min`
  return `${Math.floor(hours / 24)} d ${hours % 24} hr`
}

function toItem(entity: HAEntity, icon: string, state: string, now: Date, inspectable = true): SecurityItem {
  return { entityId: entity.entity_id, name: friendlyName(entity), state, since: elapsed(entity, now), icon, inspectable }
}

export function SecurityPanel({ entities, onInspect, onOpenSection, onClose, now }: SecurityPanelProps) {
  const all = Array.from(entities.values())
  const openDoorCountEntity = entities.get('sensor.doors_open_count')

  const openDoors = all
    .filter((entity) => entity.entity_id.startsWith('binary_sensor.') && matchesDoorSignal(entity) && entity.state === 'on')
    .map((entity) => toItem(entity, 'door-open', deviceClass(entity) === 'window' ? 'Window open' : 'Open', now))

  const countValue = Number(openDoorCountEntity?.state)
  const reportedOpenDoors = Number.isFinite(countValue) ? countValue : 0
  if (reportedOpenDoors > openDoors.length) {
    openDoors.push({
      entityId: openDoorCountEntity?.entity_id ?? 'sensor.doors_open_count',
      name: 'Additional open doors',
      state: `${reportedOpenDoors - openDoors.length} unclassified sensor${reportedOpenDoors - openDoors.length === 1 ? '' : 's'}`,
      since: 'Reported by aggregate counter',
      icon: 'door-open',
      inspectable: false,
    })
  }
  const openCovers = all
    .filter((entity) => entity.entity_id.startsWith('cover.') && ['open', 'opening'].includes(entity.state))
    .map((entity) => toItem(entity, 'warehouse', entity.state === 'opening' ? 'Opening' : 'Open', now))
  const unlockedLocks = all
    .filter((entity) => entity.entity_id.startsWith('lock.') && ['unlocked', 'open', 'jammed'].includes(entity.state))
    .map((entity) => toItem(entity, 'lock', entity.state === 'jammed' ? 'Jammed' : 'Unlocked', now))
  const leaks = all
    .filter((entity) => entity.entity_id.startsWith('binary_sensor.') && deviceClass(entity) === 'moisture' && entity.state === 'on')
    .map((entity) => toItem(entity, 'droplets', 'Moisture detected', now))
  const problems = all
    .filter((entity) => entity.entity_id.startsWith('binary_sensor.') && deviceClass(entity) === 'problem' && entity.state === 'on')
    .map((entity) => toItem(entity, 'shield', 'Reporting a problem', now))

  const groups: SecurityGroup[] = ([
    { id: 'doors', title: 'Open doors and windows', icon: DoorOpen, tone: 'danger', items: openDoors },
    { id: 'covers', title: 'Open covers and garage', icon: Warehouse, tone: 'danger', items: openCovers },
    { id: 'locks', title: 'Unlocked locks', icon: Lock, tone: 'danger', items: unlockedLocks },
    { id: 'leaks', title: 'Leak sensors', icon: Droplets, tone: 'danger', items: leaks },
    { id: 'problems', title: 'Devices reporting problems', icon: Wrench, tone: 'warn', items: problems },
  ] satisfies SecurityGroup[]).filter((group) => group.items.length > 0)

  const total = groups.reduce((sum, group) => sum + group.items.length, 0)

  return (
    <div className="detail-backdrop" role="presentation" onClick={onClose}>
      <section className="detail-sheet security-sheet" role="dialog" aria-modal="true" aria-labelledby="security-title" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <header>
          <span className="detail-icon"><ShieldCheck size={24} /></span>
          <div><p>Live security status</p><h2 id="security-title">{total ? `${total} item${total === 1 ? '' : 's'} need attention` : 'Everything is secure'}</h2></div>
          <button onClick={onClose} title="Close" aria-label="Close security details"><X size={20} /></button>
        </header>

        {groups.length === 0 ? (
          <div className="security-clear">
            <ShieldCheck size={30} />
            <strong>All doors closed and locked</strong>
            <p>No open doors or windows, no unlocked locks, and no leak or device faults reported right now.</p>
          </div>
        ) : (
          <div className="security-groups">
            {groups.map((group) => {
              const GroupIcon = group.icon
              return (
                <section key={group.id} className={`security-group tone-${group.tone}`}>
                  <h3><GroupIcon size={16} />{group.title}<em>{group.items.length}</em></h3>
                  <div className="security-rows">
                    {group.items.map((item) => (
                      <button
                        key={item.entityId}
                        onClick={() => {
                          if (item.inspectable === false) return
                          onInspect({ entityId: item.entityId, label: item.name, kind: 'sensor', icon: item.icon })
                        }}
                        aria-label={`Open ${item.name} details`}
                        disabled={item.inspectable === false}
                      >
                        <div><strong>{item.name}</strong><small>{item.state} · {item.since}</small></div>
                        {item.inspectable === false ? <span className="security-hint">Check HA sensors</span> : <ArrowRight size={16} aria-hidden="true" />}
                      </button>
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        )}

        <button className="security-section-link" onClick={onOpenSection}>Open the Security page<ArrowRight size={16} aria-hidden="true" /></button>
      </section>
    </div>
  )
}
