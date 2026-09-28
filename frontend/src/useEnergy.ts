import { useEffect, useMemo, useState } from 'react'
import { friendlyName } from './entityNames'
import { fetchHistory, parseHistoryStates } from './history'
import type { HistoryPoint } from './history'
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

const HISTORY_HOURS = 720
/** Thirty days of counter history moves by one sample an hour; a half-hour-old copy is as good as fresh. */
const COUNTER_TTL_MS = 30 * 60_000
/** Today's daily-reset sensors climb all day, so their history is refreshed more often. */
const TODAY_TTL_MS = 5 * 60_000

function unitOf(entity: HAEntity): string | undefined {
  const unit = entity.attributes.unit_of_measurement
  return typeof unit === 'string' ? unit : undefined
}

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
  const stripped = friendlyName(entity, '').replace(FRIENDLY_SUFFIX, '').trim()
  return stripped || titleCase(prefix)
}

interface GroupAccumulator {
  prefix: string
  name: string
  yesterday: number | null
  thisMonth: number | null
  lastMonth: number | null
}

/** Local calendar day for a timestamp, `YYYY-MM-DD`. */
export function dayKey(timestamp: number) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function monthPrefix(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/** Highest reading seen on each local day, oldest first. */
function dailyMaxima(points: HistoryPoint[], unit: string | undefined): [string, number][] {
  const maxByDay = new Map<string, number>()
  for (const point of points) {
    const key = dayKey(point.time)
    const kWh = toKWh(point.value, unit)
    const current = maxByDay.get(key)
    if (current === undefined || kWh > current) maxByDay.set(key, kWh)
  }
  return [...maxByDay.entries()].sort(([left], [right]) => (left < right ? -1 : 1))
}

/**
 * A sensor that resets at midnight: unlike a lifetime counter there is nothing to difference, the
 * highest value seen on a day is what that day used.
 */
export function summariseDailyReset(points: HistoryPoint[], unit: string | undefined): DailyUsage[] {
  return dailyMaxima(points, unit).map(([day, kWh]) => ({ day, kWh }))
}

/**
 * Per-day usage from a lifetime-increasing counter, differenced day over day from each day's
 * maximum. `now` is injectable so the month arithmetic can be checked at a month boundary.
 */
export function summariseCounter(entity: HAEntity, points: HistoryPoint[], now = new Date()): EnergyDevice {
  const base: EnergyDevice = {
    id: entity.entity_id,
    name: friendlyName(entity),
    yesterdayKWh: null,
    thisMonthKWh: null,
    lastMonthKWh: null,
    currentPeriodKWh: 0,
    isBareCounter: true,
    daily: [],
  }
  if (!points.length) return base

  const days = dailyMaxima(points, unitOf(entity))
  const diffs: { day: string; usage: number }[] = []
  for (let i = 1; i < days.length; i++) {
    const [day, max] = days[i]
    const [, prevMax] = days[i - 1]
    // A counter that was reset (or replaced) reads lower than yesterday; that is not negative usage.
    diffs.push({ day, usage: Math.max(0, max - prevMax) })
  }

  const todayKey = dayKey(now.getTime())
  const yesterdayDate = new Date(now)
  yesterdayDate.setDate(yesterdayDate.getDate() - 1)
  const yesterdayKey = dayKey(yesterdayDate.getTime())
  const thisMonthPrefix = monthPrefix(now)
  const lastMonthPrefix = monthPrefix(new Date(now.getFullYear(), now.getMonth() - 1, 1))

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
}

async function loadDailyResetCounter(entity: HAEntity): Promise<DailyUsage[]> {
  try {
    const payload = await fetchHistory(entity.entity_id, HISTORY_HOURS, TODAY_TTL_MS)
    return summariseDailyReset(parseHistoryStates(payload), unitOf(entity))
  } catch {
    return []
  }
}

async function loadBareCounter(entity: HAEntity): Promise<EnergyDevice> {
  try {
    const payload = await fetchHistory(entity.entity_id, HISTORY_HOURS, COUNTER_TTL_MS)
    return summariseCounter(entity, parseHistoryStates(payload))
  } catch {
    return summariseCounter(entity, [])
  }
}

interface Classified {
  energyEntities: HAEntity[]
  groupedDevices: EnergyDevice[]
  bareEntities: HAEntity[]
  todayEntities: HAEntity[]
}

/** Sorts every `device_class: energy` sensor into grouped-device siblings, bare lifetime counters and daily-reset sensors. */
export function classifyEnergyEntities(entities: Map<string, HAEntity>): Classified {
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
    const rawValue = Number(entity.state)
    const value = Number.isFinite(rawValue) ? toKWh(rawValue, unitOf(entity)) : null
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

  return { energyEntities, groupedDevices, bareEntities, todayEntities }
}

/** Changes exactly when an energy sensor's reading does, so the classification above is not redone on every unrelated WebSocket frame. */
export function energySignature(entities: Map<string, HAEntity>) {
  const parts: string[] = []
  for (const entity of entities.values()) {
    if (entity.attributes.device_class === 'energy') parts.push(`${entity.entity_id}=${entity.state}`)
  }
  return parts.join('|')
}

/**
 * Discovers `device_class: energy` sensors and normalizes them into per-device usage.
 * Handles two shapes: pre-aggregated devices with `_energy_yesterday` / `_energy_this_month` /
 * `_energy_last_month` sibling sensors (read directly from current state), and bare lifetime
 * counters with no such siblings (derived from 30 days of history).
 */
export function useEnergy(entities: Map<string, HAEntity>): UseEnergyResult {
  const signature = energySignature(entities)
  // The signature encodes every energy reading the classifier consumes; the Map itself changes on
  // every WebSocket frame and would defeat the memo.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { energyEntities, groupedDevices, bareEntities, todayEntities } = useMemo(() => classifyEnergyEntities(entities), [signature])

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

  return useMemo(() => {
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
  }, [bareEntities, bareResults, groupedDevices, todayResults, bareEntityIds, todayEntityIds, loading, energyEntities.length])
}
