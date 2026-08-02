import { useEffect, useState } from 'react'
import { apiUrl } from './api'
import type { HAEntity } from './types'

export interface DailyUsage {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string
  kWh: number
}

/** A single appliance/device, or a bare cumulative counter, normalized to kWh. */
export interface EnergyDevice {
  id: string
  name: string
  yesterdayKWh: number | null
  thisMonthKWh: number | null
  lastMonthKWh: number | null
  /** Best comparison figure for the current period: this-month for grouped devices, last-30-days sum for bare counters. */
  currentPeriodKWh: number
  isBareCounter: boolean
  /** Per-day usage, only derivable for bare counters (grouped devices publish totals, not history). */
  daily: DailyUsage[]
}

export interface UseEnergyResult {
  devices: EnergyDevice[]
  wholeHome: EnergyDevice | null
  /** Per-day totals across every tracked source, most recent last. */
  daily: DailyUsage[]
  loading: boolean
  isEmpty: boolean
}

/** Matches e.g. `washer_energy_yesterday` -> prefix `washer`, period `yesterday`. */
const GROUP_SUFFIX = /^(.+)_energy_(yesterday|this_month|last_month)$/
/** Daily-resetting "energy today" sensors: their peak each day *is* that day's usage. */
const TODAY_SENSOR = /_energy_today$/
const FRIENDLY_SUFFIX = /\s+Energy\s+(Yesterday|This\s+Month|Last\s+Month)$/i
const WHOLE_HOME_HINTS = ['smarthub', 'utility', 'grid', 'whole_home', 'wholehome', 'main_meter']

function toKWh(value: number, unit: string | undefined) {
  return unit === 'Wh' ? value / 1000 : value
}

function titleCase(slug: string) {
  return slug
    .split('_')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')
}

function friendlyBase(entity: HAEntity, prefix: string) {
  const friendly = String(entity.attributes.friendly_name ?? '')
  const stripped = friendly.replace(FRIENDLY_SUFFIX, '').trim()
  return stripped || titleCase(prefix)
}

interface GroupAccumulator {
  prefix: string
  name: string
  yesterday: number | null
  thisMonth: number | null
  lastMonth: number | null
}

interface HistoryPoint {
  time: number
  value: number
}

function parseHistoryPoints(payload: unknown): HistoryPoint[] {
  if (!Array.isArray(payload)) return []
  const states = Array.isArray(payload[0]) ? payload[0] : payload
  return states.flatMap((item): HistoryPoint[] => {
    if (!item || typeof item !== 'object') return []
    const state = item as Record<string, unknown>
    const value = Number(state.state)
    const time = Date.parse(String(state.last_changed ?? state.last_updated ?? ''))
    return Number.isFinite(value) && Number.isFinite(time) ? [{ time, value }] : []
  })
}

function dayKey(timestamp: number) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * Fetches 30 days of history for a sensor that resets at midnight. Unlike a lifetime counter there
 * is nothing to difference: the highest value seen on a day is what that day used.
 */
async function loadDailyResetCounter(entity: HAEntity): Promise<DailyUsage[]> {
  const unit = entity.attributes.unit_of_measurement as string | undefined
  try {
    const response = await fetch(apiUrl(`history/${entity.entity_id}?hours=720`))
    if (!response.ok) return []
    const maxByDay = new Map<string, number>()
    for (const point of parseHistoryPoints(await response.json())) {
      const key = dayKey(point.time)
      const kWh = toKWh(point.value, unit)
      const current = maxByDay.get(key)
      if (current === undefined || kWh > current) maxByDay.set(key, kWh)
    }
    return [...maxByDay.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([day, kWh]) => ({ day, kWh }))
  } catch {
    return []
  }
}

/** Fetches 30 days of history for a lifetime-increasing counter and derives per-day usage from day-over-day maxima. */
async function loadBareCounter(entity: HAEntity): Promise<EnergyDevice> {
  const unit = entity.attributes.unit_of_measurement as string | undefined
  const name = String(entity.attributes.friendly_name ?? entity.entity_id)
  const base: EnergyDevice = {
    id: entity.entity_id,
    name,
    yesterdayKWh: null,
    thisMonthKWh: null,
    lastMonthKWh: null,
    currentPeriodKWh: 0,
    isBareCounter: true,
    daily: [],
  }

  try {
    const response = await fetch(apiUrl(`history/${entity.entity_id}?hours=720`))
    if (!response.ok) return base
    const points = parseHistoryPoints(await response.json())
    if (!points.length) return base

    const maxByDay = new Map<string, number>()
    for (const point of points) {
      const key = dayKey(point.time)
      const kWh = toKWh(point.value, unit)
      const current = maxByDay.get(key)
      if (current === undefined || kWh > current) maxByDay.set(key, kWh)
    }
    const days = [...maxByDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    const diffs: { day: string; usage: number }[] = []
    for (let i = 1; i < days.length; i++) {
      const [day, max] = days[i]
      const [, prevMax] = days[i - 1]
      diffs.push({ day, usage: Math.max(0, max - prevMax) })
    }

    const now = new Date()
    const todayKey = dayKey(now.getTime())
    const yesterdayDate = new Date(now)
    yesterdayDate.setDate(yesterdayDate.getDate() - 1)
    const yesterdayKey = dayKey(yesterdayDate.getTime())
    const thisMonthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const lastMonthPrefix = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`

    const yesterdayUsage = diffs.find((d) => d.day === yesterdayKey)?.usage ?? null
    const thisMonthDiffs = diffs.filter((d) => d.day.startsWith(thisMonthPrefix))
    const lastMonthDiffs = diffs.filter((d) => d.day.startsWith(lastMonthPrefix))
    // Only trust a last-month total once most of that month's days are present in the 30-day window.
    const lastMonthUsage = lastMonthDiffs.length >= 25 ? lastMonthDiffs.reduce((sum, d) => sum + d.usage, 0) : null

    const last30 = diffs.filter((d) => d.day !== todayKey)
    const currentPeriodKWh = last30.reduce((sum, d) => sum + d.usage, 0)

    return {
      ...base,
      yesterdayKWh: yesterdayUsage,
      thisMonthKWh: thisMonthDiffs.length ? thisMonthDiffs.reduce((sum, d) => sum + d.usage, 0) : null,
      lastMonthKWh: lastMonthUsage,
      currentPeriodKWh,
      daily: diffs.map((entry) => ({ day: entry.day, kWh: entry.usage })),
    }
  } catch {
    return base
  }
}

/**
 * Discovers `device_class: energy` sensors and normalizes them into per-device usage.
 * Handles two shapes: pre-aggregated devices with `_energy_yesterday` / `_energy_this_month` /
 * `_energy_last_month` sibling sensors (read directly from current state), and bare lifetime
 * counters with no such siblings (derived from 30 days of history).
 */
export function useEnergy(entities: Map<string, HAEntity>): UseEnergyResult {
  const energyEntities = Array.from(entities.values()).filter((entity) => entity.attributes.device_class === 'energy')

  const groups = new Map<string, GroupAccumulator>()
  const bareEntities: HAEntity[] = []
  const todayEntities: HAEntity[] = []

  for (const entity of energyEntities) {
    const localId = entity.entity_id.split('.')[1] ?? ''
    if (TODAY_SENSOR.test(localId)) {
      todayEntities.push(entity)
      continue
    }
    const match = entity.entity_id.match(GROUP_SUFFIX)
    if (!match) {
      bareEntities.push(entity)
      continue
    }
    const [, prefix, period] = match
    const unit = entity.attributes.unit_of_measurement as string | undefined
    const rawValue = Number(entity.state)
    const value = Number.isFinite(rawValue) ? toKWh(rawValue, unit) : null
    const existing = groups.get(prefix) ?? {
      prefix,
      name: friendlyBase(entity, prefix),
      yesterday: null,
      thisMonth: null,
      lastMonth: null,
    }
    if (period === 'yesterday') existing.yesterday = value
    else if (period === 'this_month') existing.thisMonth = value
    else if (period === 'last_month') existing.lastMonth = value
    groups.set(prefix, existing)
  }

  const groupedDevices: EnergyDevice[] = Array.from(groups.values()).map((group) => ({
    id: group.prefix,
    name: group.name,
    yesterdayKWh: group.yesterday,
    thisMonthKWh: group.thisMonth,
    lastMonthKWh: group.lastMonth,
    currentPeriodKWh: group.thisMonth ?? group.yesterday ?? 0,
    isBareCounter: false,
    daily: [],
  }))

  const bareEntityIds = bareEntities.map((entity) => entity.entity_id).sort().join(',')
  const todayEntityIds = todayEntities.map((entity) => entity.entity_id).sort().join(',')

  // Fetched results are cached by entity id and never cleared; the ids actually requested
  // (bareEntityIds) determine what's shown, so a shrinking bare-entity set still renders correctly.
  const [bareResults, setBareResults] = useState<Map<string, EnergyDevice>>(new Map())
  const [todayResults, setTodayResults] = useState<Map<string, DailyUsage[]>>(new Map())
  const [loading, setLoading] = useState(bareEntityIds.length > 0)

  useEffect(() => {
    if (!todayEntityIds) return
    let stopped = false
    const targets = todayEntityIds.split(',').flatMap((id) => {
      const entity = entities.get(id)
      return entity ? [entity] : []
    })
    Promise.all(targets.map(async (entity) => [entity.entity_id, await loadDailyResetCounter(entity)] as const))
      .then((results) => {
        if (stopped) return
        setTodayResults(new Map(results))
      })
      .catch(() => undefined)
    return () => { stopped = true }
    // Same reasoning as the bare-counter effect: refetch on set changes, not on every state tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayEntityIds])

  useEffect(() => {
    if (!bareEntityIds) return
    let stopped = false
    queueMicrotask(() => {
      if (!stopped) setLoading(true)
    })
    const targets = bareEntityIds.split(',').flatMap((id) => {
      const entity = entities.get(id)
      return entity ? [entity] : []
    })
    Promise.all(targets.map(loadBareCounter))
      .then((results) => {
        if (stopped) return
        setBareResults((previous) => {
          const next = new Map(previous)
          for (const result of results) next.set(result.id, result)
          return next
        })
      })
      .finally(() => {
        if (!stopped) setLoading(false)
      })
    return () => {
      stopped = true
    }
    // Refetch only when the *set* of bare-counter entity ids changes, not on every state tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bareEntityIds])

  const bareDevices = bareEntities.flatMap((entity) => {
    const result = bareResults.get(entity.entity_id)
    return result ? [result] : []
  })
  const allDevices = [...groupedDevices, ...bareDevices]
  const wholeHomeIndex = allDevices.findIndex(
    (device) =>
      device.isBareCounter &&
      WHOLE_HOME_HINTS.some((hint) => device.id.toLowerCase().includes(hint) || device.name.toLowerCase().includes(hint)),
  )
  const wholeHome = wholeHomeIndex >= 0 ? allDevices[wholeHomeIndex] : null
  const devices = wholeHomeIndex >= 0 ? allDevices.filter((_, index) => index !== wholeHomeIndex) : allDevices

  // The whole-home meter already covers everything downstream of it, so mixing it with per-appliance
  // series would double-count. Prefer it alone, then any other lifetime counter, and fall back to
  // the daily-reset "energy today" sensors when neither has usable history.
  const counterSeries = (wholeHome ? [wholeHome] : allDevices).flatMap((device) => device.daily)
  const dailySources = counterSeries.length > 1 ? counterSeries : [...todayResults.values()].flat()
  const dailyTotals = new Map<string, number>()
  for (const entry of dailySources) {
    dailyTotals.set(entry.day, (dailyTotals.get(entry.day) ?? 0) + entry.kWh)
  }
  const daily = [...dailyTotals.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([day, kWh]) => ({ day, kWh }))

  return {
    devices,
    wholeHome,
    daily,
    loading: bareEntityIds ? loading : Boolean(todayEntityIds) && todayResults.size === 0,
    isEmpty: energyEntities.length === 0,
  }
}
