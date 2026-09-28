import type { HAEntity } from './types'

/**
 * The name a person would use for an entity: Home Assistant's `friendly_name`, or the object id
 * with its underscores spaced out (`sensor.attic_sensor_temperature` -> `attic sensor temperature`).
 * Eight files each had their own copy of this line with subtly different fallbacks.
 */
export function friendlyName(entity: HAEntity | null | undefined, fallback?: string): string {
  if (!entity) return fallback ?? ''
  const friendly = entity.attributes.friendly_name
  if (typeof friendly === 'string' && friendly.trim()) return friendly
  if (fallback !== undefined) return fallback
  const objectId = entity.entity_id.split('.')[1]
  return objectId ? objectId.replaceAll('_', ' ') : entity.entity_id
}
