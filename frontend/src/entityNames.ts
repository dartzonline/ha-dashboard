import type { HAEntity } from './types'

/**
 * The name a person would use for an entity: Home Assistant's `friendly_name`, or the object id
 * with its underscores spaced out (`sensor.attic_sensor_temperature` -> `attic sensor temperature`).
 * Eight files each had their own copy of this line with subtly different fallbacks.
 */
export function friendlyName(entity: HAEntity | null | undefined, fallback?: string): string {
  if (!entity) return fallback ?? ''
  const friendly = entity.attributes.friendly_name
  if (typeof friendly === 'string' && friendly.trim()) return tidyName(friendly)
  if (fallback !== undefined) return fallback
  const objectId = entity.entity_id.split('.')[1]
  return objectId ? objectId.replaceAll('_', ' ') : entity.entity_id
}

/**
 * Home Assistant builds names from device + entity, so a door sensor on a device called "Media
 * Door" comes out as "Media Door Door". Repeated neighbouring words are collapsed and the first
 * letter capitalised ("pantry door Door" -> "Pantry door").
 */
export function tidyName(name: string): string {
  const words = name.trim().split(/\s+/)
  const kept = words.filter((word, index) => index === 0 || word.toLowerCase() !== words[index - 1].toLowerCase())
  const joined = kept.join(' ')
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}
