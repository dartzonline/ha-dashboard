import type { HAEntity, TileKind } from './types'

/** One entity's row from `GET /api/registry` (backend/app/entity_registry.py). */
export interface RegistryMeta {
  areaId: string | null
  category: string | null
  disabled: boolean
  hidden: boolean
  deviceId: string | null
}

export interface RegistrySnapshot {
  entities: Record<string, RegistryMeta>
  areas: Record<string, string>
}

/** A tile the classifier thinks should exist, pre-filled for the Configure panel to confirm. */
export interface TileProposal {
  entityId: string
  sectionId: string
  label: string
  kind: TileKind
  icon: string
}

export type Classification = TileProposal | 'skip' | 'review'

/**
 * Domains that never earn a tile on this dashboard: helpers, plumbing and UI-only entities that
 * would otherwise flood the review list. Kept narrow on purpose -- anything that might plausibly
 * belong on a wall display goes to review instead, where a human sees it once.
 */
const NON_TILE_DOMAINS = new Set([
  'automation', 'button', 'conversation', 'date', 'datetime', 'event', 'number', 'persistent_notification',
  'select', 'stt', 'sun', 'tag', 'text', 'time', 'todo', 'tts', 'update', 'zone',
  // Helper and plumbing domains. A dry run over this household's 833 live entities put 16 of these
  // in the review list on their own -- kiosk timers, input_text scratch values, notify targets --
  // none of which is ever a device worth a tile.
  'calendar', 'counter', 'input_boolean', 'input_datetime', 'input_number', 'input_select',
  'input_text', 'notify', 'schedule', 'timer',
  // WeatherView owns forecast entities outright, the same way EnergyView owns energy sensors.
  'weather',
])

/** Same naming heuristic as `safe_lighting_switch` in backend/app/main.py, which reads id + friendly name. */
const LIGHT_TERMS = ['light', 'lighting', 'lamp', 'sconce', 'chandelier']
const APPLIANCE_TERMS = [
  'washer', 'washing', 'dryer', 'dishwasher', 'fridge', 'refrigerator', 'freezer',
  'oven', 'stove', 'microwave', 'kettle', 'coffee', 'air_fryer', 'printer',
]
const GARAGE_TERMS = ['garage', 'gate']

const SECURITY_BINARY_CLASSES = new Set(['door', 'garage_door', 'window', 'opening', 'moisture'])
const PRESENCE_BINARY_CLASSES = new Set(['motion', 'occupancy', 'presence'])

function domainOf(entityId: string) {
  return entityId.split('.')[0] ?? ''
}

/** Lowercased id + friendly name, the haystack both this and the backend's heuristics search. */
function searchable(entity: HAEntity) {
  return `${entity.entity_id} ${String(entity.attributes.friendly_name ?? '')}`.toLowerCase()
}

function labelFor(entity: HAEntity) {
  const fallback = entity.entity_id.split('.')[1]?.replaceAll('_', ' ') ?? entity.entity_id
  return String(entity.attributes.friendly_name ?? fallback)
}

function deviceClassOf(entity: HAEntity) {
  const value = entity.attributes.device_class
  return typeof value === 'string' ? value : ''
}

function propose(entity: HAEntity, sectionId: string, kind: TileKind, icon: string): TileProposal {
  return { entityId: entity.entity_id, sectionId, label: labelFor(entity), kind, icon }
}

/**
 * Decides where a newly seen entity belongs -- see the rule table in docs/auto-entity-discovery.md.
 *
 * Pure and dependency-free so the rules can be exercised without a browser or a live Home Assistant.
 * Order matters: skips first (registry metadata, then entities another view already owns), then the
 * unambiguous domains, then naming heuristics. Anything left is `'review'` rather than a guess --
 * a wrong tile on a wall display is worse than one the household places by hand.
 *
 * `vacuumDeviceIds` carries the device ids that own a `vacuum.*` entity, which is the only way to
 * recognise a Roborock's filter-life sensor or child-lock switch: nothing in its own state says so.
 * `companionDeviceIds` does the same for phones (devices owning a `device_tracker.*`).
 */
export function classify(
  entity: HAEntity,
  meta: RegistryMeta | undefined,
  vacuumDeviceIds: ReadonlySet<string> = new Set(),
  companionDeviceIds: ReadonlySet<string> = new Set(),
): Classification {
  if (meta && (meta.disabled || meta.hidden || meta.category === 'diagnostic' || meta.category === 'config')) return 'skip'

  const domain = domainOf(entity.entity_id)
  const deviceClass = deviceClassOf(entity)

  // Entities other views already render from the live entity map, with no tile config of their own.
  if (domain === 'person' || domain === 'device_tracker') return 'skip'
  if (domain === 'sensor' && (deviceClass === 'energy' || deviceClass === 'battery')) return 'skip'
  if (NON_TILE_DOMAINS.has(domain)) return 'skip'

  // Companion-app telemetry: step counts, storage, SSID, focus mode. Home Assistant's mobile app
  // does not mark these `diagnostic`, so the registry filter above misses them, yet 26 of this
  // household's review items were exactly this. The phone itself is already on the dashboard
  // through PresenceRow; its accelerometer is not a device anyone wants a tile for.
  if (meta?.deviceId && companionDeviceIds.has(meta.deviceId)) return 'skip'

  if ((domain === 'sensor' || domain === 'switch') && meta?.deviceId && vacuumDeviceIds.has(meta.deviceId)) {
    return propose(entity, 'roborock', domain === 'switch' ? 'toggle' : 'sensor', domain === 'switch' ? 'bot' : 'filter')
  }

  switch (domain) {
    case 'light':
      return propose(entity, 'lights', 'toggle', 'lightbulb')
    case 'lock':
      return propose(entity, 'security', 'lock', 'lock')
    case 'climate':
      return propose(entity, 'climate', 'thermostat', 'thermometer')
    case 'vacuum':
      return propose(entity, 'roborock', 'vacuum', 'bot')
    case 'media_player':
      return propose(entity, 'appliances', 'toggle', 'tv')
    case 'scene':
    case 'script':
      return propose(entity, 'scenes', 'sensor', 'sparkles')
    default:
      break
  }

  const haystack = searchable(entity)

  if (domain === 'cover') {
    // Garage doors and gates read as security, matching the existing cover.ratgdov25i_8e54c8_door tile;
    // blinds and shades are a lighting concern.
    const isGarage = deviceClass === 'garage' || GARAGE_TERMS.some((term) => haystack.includes(term))
    return isGarage ? propose(entity, 'security', 'sensor', 'warehouse') : propose(entity, 'lights', 'toggle', 'door-open')
  }

  if (domain === 'binary_sensor') {
    if (SECURITY_BINARY_CLASSES.has(deviceClass)) {
      return propose(entity, 'security', 'sensor', deviceClass === 'moisture' ? 'droplets' : 'door-open')
    }
    if (PRESENCE_BINARY_CLASSES.has(deviceClass)) return propose(entity, 'security', 'sensor', 'scan')
    return 'review'
  }

  if (domain === 'switch') {
    if (LIGHT_TERMS.some((term) => haystack.includes(term))) return propose(entity, 'lights', 'toggle', 'lamp')
    if (APPLIANCE_TERMS.some((term) => haystack.includes(term))) return propose(entity, 'appliances', 'toggle', 'washing-machine')
    return 'review'
  }

  if (domain === 'sensor') {
    if (deviceClass === 'temperature') return propose(entity, 'climate', 'sensor', 'thermometer')
    if (deviceClass === 'humidity') return propose(entity, 'climate', 'sensor', 'droplets')
    return 'review'
  }

  return 'review'
}

/**
 * Device ids owning at least one entity in `domain`, so a nondescript sensor can be judged by the
 * device it belongs to rather than by its own name. Used twice: `vacuum` groups the Roborock's
 * filter/brush/DND entities into that section, and `device_tracker` identifies phones, whose
 * companion-app telemetry should not become tiles.
 */
export function deviceIdsOwningDomain(
  entities: Iterable<HAEntity>,
  registry: RegistrySnapshot | null,
  domain: string,
): Set<string> {
  const deviceIds = new Set<string>()
  if (!registry) return deviceIds
  for (const entity of entities) {
    if (domainOf(entity.entity_id) !== domain) continue
    const deviceId = registry.entities[entity.entity_id]?.deviceId
    if (deviceId) deviceIds.add(deviceId)
  }
  return deviceIds
}
