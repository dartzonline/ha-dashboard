import type { HAEntity } from './types'

/**
 * AdGuard Home reaches Home Assistant through its own integration, which adds a handful of switches
 * (protection, filtering, safe browsing...) and sensors (queries, blocked, rate...). Their ids all
 * carry "adguard", so the tab finds them by name instead of by a fixed id, and works whatever the
 * device is called.
 */

export type AdGuardSwitchKey = 'protection' | 'filtering' | 'safeBrowsing' | 'parental' | 'safeSearch' | 'queryLog'
export type AdGuardStatKey = 'queries' | 'blocked' | 'ratio' | 'speed' | 'rules' | 'safeBrowsingBlocked' | 'parentalBlocked' | 'safeSearches'

/** Longest suffix first: "dns_queries_blocked_ratio" must win over "dns_queries". */
const SWITCH_SUFFIXES: [string, AdGuardSwitchKey][] = [
  ['_protection', 'protection'],
  ['_filtering', 'filtering'],
  ['_safe_browsing', 'safeBrowsing'],
  ['_parental_control', 'parental'],
  ['_safe_search', 'safeSearch'],
  ['_query_log', 'queryLog'],
]

const STAT_SUFFIXES: [string, AdGuardStatKey][] = [
  ['_dns_queries_blocked_ratio', 'ratio'],
  ['_dns_queries_blocked', 'blocked'],
  ['_dns_queries', 'queries'],
  ['_average_processing_speed', 'speed'],
  ['_rules_count', 'rules'],
  ['_safe_browsing_blocked', 'safeBrowsingBlocked'],
  ['_parental_control_blocked', 'parentalBlocked'],
  ['_safe_searches_enforced', 'safeSearches'],
]

export const SWITCH_LABELS: Record<AdGuardSwitchKey, { label: string; hint: string }> = {
  protection: { label: 'Protection', hint: 'The master switch. Off, nothing is filtered at all.' },
  filtering: { label: 'Filtering', hint: 'Applies your blocklists to every lookup.' },
  safeBrowsing: { label: 'Safe browsing', hint: 'Blocks known malware and phishing sites.' },
  parental: { label: 'Parental control', hint: 'Blocks adult content.' },
  safeSearch: { label: 'Safe search', hint: 'Forces safe search on search engines.' },
  queryLog: { label: 'Query log', hint: 'Keeps a record of lookups in AdGuard.' },
}

export interface AdGuardModel {
  switches: Partial<Record<AdGuardSwitchKey, HAEntity>>
  stats: Partial<Record<AdGuardStatKey, HAEntity>>
  /** The add-on's own update entity, when there is one: proof AdGuard is installed even if not linked. */
  addon: HAEntity | null
}

function suffixMatch<K extends string>(entityId: string, table: [string, K][]): K | null {
  const local = entityId.split('.')[1] ?? ''
  for (const [suffix, key] of table) if (local.endsWith(suffix)) return key
  return null
}

export function adguardModel(entities: Map<string, HAEntity>): AdGuardModel {
  const model: AdGuardModel = { switches: {}, stats: {}, addon: null }
  for (const entity of entities.values()) {
    const id = entity.entity_id
    if (!id.includes('adguard')) continue
    if (id.startsWith('update.')) { model.addon = entity; continue }
    if (id.startsWith('switch.')) {
      const key = suffixMatch(id, SWITCH_SUFFIXES)
      if (key && !model.switches[key]) model.switches[key] = entity
    } else if (id.startsWith('sensor.')) {
      const key = suffixMatch(id, STAT_SUFFIXES)
      if (key && !model.stats[key]) model.stats[key] = entity
    }
  }
  return model
}

/** Linked means Home Assistant has the integration's entities, not merely the add-on. */
export function isLinked(model: AdGuardModel) {
  return Object.keys(model.switches).length > 0 || Object.keys(model.stats).length > 0
}

export type Blocking = 'working' | 'protection-off' | 'filtering-off' | 'unknown'

/** Ads are only blocked while the master switch AND the blocklist switch are both on. */
export function blockingState(model: AdGuardModel): Blocking {
  const protection = model.switches.protection?.state
  const filtering = model.switches.filtering?.state
  if (!protection || protection === 'unavailable' || protection === 'unknown') return 'unknown'
  if (protection !== 'on') return 'protection-off'
  if (filtering === 'off') return 'filtering-off'
  return 'working'
}

export function number(entity: HAEntity | undefined): number | null {
  if (!entity) return null
  const value = Number(entity.state)
  return Number.isFinite(value) && entity.state !== '' ? value : null
}

/** "12,345", or "1.2k" once a number is long enough to crowd a card. */
export function compactCount(value: number | null) {
  if (value === null) return '—'
  if (value >= 100_000) return `${(value / 1000).toFixed(0)}k`
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`
  return Math.round(value).toLocaleString()
}

/** How long ago, in the largest sensible unit: "since 3 days ago", "since 12 min ago". */
export function sinceLabel(iso: string | undefined, now = Date.now()) {
  const then = iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(then)) return null
  const minutes = Math.max(0, Math.round((now - then) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}
