import { useEffect, useState } from 'react'
import { apiUrl } from './api'
import { classify, deviceIdsOwningDomain } from './entityClassifier'
import type { RegistrySnapshot, TileProposal } from './entityClassifier'
import type { DashboardConfigResponse, DashboardSection, HAEntity } from './types'

/**
 * Registry metadata changes only when devices are added or renamed in Home Assistant, and the
 * backend caches it for five minutes anyway -- so this mirrors useSparkline's module-level cache
 * with in-flight dedupe, and the Configure panel re-opening costs nothing.
 */
const registryCache: { snapshot: RegistrySnapshot | null; fetchedAt: number } = { snapshot: null, fetchedAt: 0 }
const CACHE_TTL_MS = 5 * 60_000
let registryInflight: Promise<RegistrySnapshot | null> | null = null

/** The dismissed list is small and written back here, so it is cached for the session rather than by TTL. */
let ignoredCache: string[] | null = null
let ignoredInflight: Promise<string[]> | null = null

/**
 * useDashboardConfig already loads `/api/config` at startup; handing the dismissed list over means
 * opening the Configure panel doesn't fetch the same document a second time, and the two never
 * disagree about what has been dismissed.
 */
export function primeIgnoredEntityIds(entityIds: string[]) {
  ignoredCache = entityIds
}

function fetchRegistry(): Promise<RegistrySnapshot | null> {
  if (registryCache.snapshot && Date.now() - registryCache.fetchedAt < CACHE_TTL_MS) return Promise.resolve(registryCache.snapshot)
  if (registryInflight) return registryInflight
  const request = fetch(apiUrl('registry'))
    .then((response) => (response.ok ? (response.json() as Promise<RegistrySnapshot>) : null))
    .then((snapshot) => {
      // A registry the WebSocket refused (no permission, HA offline) must not be cached as "empty",
      // or every entity would look like it has no metadata and diagnostic noise would be proposed.
      if (snapshot) {
        registryCache.snapshot = snapshot
        registryCache.fetchedAt = Date.now()
      }
      return snapshot
    })
    .catch(() => null)
    .finally(() => { registryInflight = null })
  registryInflight = request
  return request
}

function fetchIgnored(): Promise<string[]> {
  if (ignoredCache) return Promise.resolve(ignoredCache)
  if (ignoredInflight) return ignoredInflight
  const request = fetch(apiUrl('config'))
    .then((response) => (response.ok ? (response.json() as Promise<DashboardConfigResponse>) : null))
    .then((data) => {
      ignoredCache = data?.ignoredEntityIds ?? []
      return ignoredCache
    })
    .catch(() => [] as string[])
    .finally(() => { ignoredInflight = null })
  ignoredInflight = request
  return request
}

export interface EntityDiscovery {
  /** Entities the classifier placed confidently, ready to confirm. */
  proposals: TileProposal[]
  /** Entities it would only be guessing about -- shown as a lower-urgency list. */
  needsReview: HAEntity[]
  loading: boolean
  dismiss: (entityId: string) => Promise<void>
}

/**
 * Diffs the live entity map against the tiles that already exist and the persisted dismissed list,
 * and classifies whatever is left. Nothing here writes tiles: proposals are suggestions the
 * Configure panel confirms, because a wrong tile is more annoying to discover after it is live.
 *
 * Dismissals persist through the same merging `PUT /api/config` the energy rate uses -- sending
 * only this slice leaves sections and Night Mode's allowlist untouched on the server.
 */
export function useEntityDiscovery(entities: Map<string, HAEntity>, sections: DashboardSection[]): EntityDiscovery {
  const [registry, setRegistry] = useState<RegistrySnapshot | null>(registryCache.snapshot)
  const [ignored, setIgnored] = useState<string[]>(() => ignoredCache ?? [])
  const [loading, setLoading] = useState(!registryCache.snapshot || !ignoredCache)

  useEffect(() => {
    let stopped = false
    Promise.all([fetchRegistry(), fetchIgnored()])
      .then(([snapshot, ignoredIds]) => {
        if (stopped) return
        setRegistry(snapshot)
        setIgnored(ignoredIds)
      })
      .finally(() => { if (!stopped) setLoading(false) })
    return () => { stopped = true }
  }, [])

  async function dismiss(entityId: string) {
    const next = ignored.includes(entityId) ? ignored : [...ignored, entityId]
    setIgnored(next)
    ignoredCache = next
    const response = await fetch(apiUrl('config'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignoredEntityIds: next }),
    })
    if (!response.ok) throw new Error('Could not save the dismissed device')
  }

  const placed = new Set<string>(ignored)
  for (const section of sections) {
    for (const tile of section.tiles) placed.add(tile.entityId)
  }

  // Without registry metadata every diagnostic sensor looks like a candidate, so classify nothing
  // until it arrives rather than proposing a wall of firmware-version tiles.
  const candidates = registry ? Array.from(entities.values()).filter((entity) => !placed.has(entity.entity_id)) : []
  const vacuumDeviceIds = deviceIdsOwningDomain(entities.values(), registry, 'vacuum')
  const companionDeviceIds = deviceIdsOwningDomain(entities.values(), registry, 'device_tracker')

  const proposals: TileProposal[] = []
  const needsReview: HAEntity[] = []
  for (const entity of candidates) {
    const result = classify(entity, registry?.entities[entity.entity_id], vacuumDeviceIds, companionDeviceIds)
    if (result === 'skip') continue
    if (result === 'review') needsReview.push(entity)
    else proposals.push(result)
  }

  proposals.sort((left, right) => left.sectionId.localeCompare(right.sectionId) || left.label.localeCompare(right.label))
  needsReview.sort((left, right) => left.entity_id.localeCompare(right.entity_id))

  return { proposals, needsReview, loading, dismiss }
}
