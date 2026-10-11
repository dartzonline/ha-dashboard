import { friendlyName } from './entityNames'
import type { HAEntity } from './types'

/**
 * Lights the backend's house-watch flags as left on (2h+), mirrored here so the
 * UtilityRail can surface the same finding without an extra round trip. Kept in
 * sync with `house_watch.py`'s LIGHT_WARN_AFTER_S and EXEMPT_LIGHT_TERMS.
 */
const WARN_AFTER_MS = 2 * 60 * 60 * 1000
const EXEMPT_LIGHT_TERMS = ['landscape']

function isExemptLight(entity: HAEntity): boolean {
  const searchable = `${entity.entity_id} ${friendlyName(entity)}`.toLowerCase()
  return EXEMPT_LIGHT_TERMS.some((term) => searchable.includes(term))
}

function isGroup(entity: HAEntity): boolean {
  return Array.isArray(entity.attributes.entity_id) || Boolean(entity.attributes.is_hue_group)
}

export interface LongRunningLight {
  entity: HAEntity
  onMs: number
}

export function longRunningLights(entities: HAEntity[], nowMs: number): LongRunningLight[] {
  return entities
    .filter((entity) => entity.entity_id.startsWith('light.') && entity.state === 'on')
    .filter((entity) => !isExemptLight(entity) && !isGroup(entity))
    .map((entity) => ({ entity, onMs: nowMs - new Date(entity.last_changed).getTime() }))
    .filter(({ onMs }) => Number.isFinite(onMs) && onMs >= WARN_AFTER_MS)
    .sort((left, right) => right.onMs - left.onMs)
}

/** '2h 05m', or '45m' under an hour. */
export function formatOnDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`
}
