import type { HAEntity } from './types'

/** Words that mark a utility's whole-home meter (as opposed to one appliance's counter). */
export const WHOLE_HOME_HINTS = ['smarthub', 'utility', 'grid', 'whole_home', 'wholehome', 'main_meter']

/** Energy sensors that could be the whole-home meter: running totals, not daily-reset counters. */
export function meterCandidates(entities: Map<string, HAEntity>): HAEntity[] {
  return Array.from(entities.values())
    .filter((entity) => entity.entity_id.startsWith('sensor.') && entity.attributes.device_class === 'energy')
    .filter((entity) => !/_(today|yesterday|last_month)$/.test(entity.entity_id))
    .sort((left, right) => left.entity_id.localeCompare(right.entity_id))
}

/**
 * The whole-home meter: the one chosen on the Energy page if it still exists, otherwise the first
 * energy sensor whose id or name looks like a utility meter. Never a hard-coded id -- a utility's
 * entity id often carries the account number and service address.
 */
export function findWholeHomeMeter(entities: Map<string, HAEntity>, preferred?: string | null): string | null {
  if (preferred && entities.has(preferred)) return preferred
  const match = meterCandidates(entities).find((entity) => {
    const text = `${entity.entity_id} ${String(entity.attributes.friendly_name ?? '')}`.toLowerCase()
    return WHOLE_HOME_HINTS.some((hint) => text.includes(hint))
  })
  return match?.entity_id ?? null
}
