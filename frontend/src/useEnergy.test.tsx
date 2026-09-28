import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearCachedJson } from './cachedFetch'
import type { HAEntity } from './types'
import { classifyEnergyEntities, dayKey, energySignature, summariseCounter, summariseDailyReset, useEnergy } from './useEnergy'

function entity(entityId: string, state: string, attributes: Record<string, unknown> = {}): HAEntity {
  return { entity_id: entityId, state, attributes: { device_class: 'energy', ...attributes }, last_changed: '', last_updated: '' }
}

/** One reading per hour, rising `perDay` kWh a day from `start` for `days` days. */
function counterHistory(start: Date, days: number, perDay: number, offset = 1000) {
  const points: { time: number; value: number }[] = []
  for (let day = 0; day < days; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const time = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day, hour, 30).getTime()
      points.push({ time, value: offset + day * perDay + (perDay * (hour + 1)) / 24 })
    }
  }
  return points
}

afterEach(() => {
  clearCachedJson()
  vi.unstubAllGlobals()
})

describe('dayKey', () => {
  it('uses the local calendar day, zero padded', () => {
    expect(dayKey(new Date(2026, 2, 5, 13).getTime())).toBe('2026-03-05')
    expect(dayKey(new Date(2026, 11, 31, 23, 59).getTime())).toBe('2026-12-31')
  })

  it('does not slip a late-evening reading into the next UTC day', () => {
    // 23:30 local on the 5th is still the 5th, whatever UTC says.
    expect(dayKey(new Date(2026, 2, 5, 23, 30).getTime())).toBe('2026-03-05')
  })
})

describe('summariseCounter', () => {
  const meter = entity('sensor.smarthub_meter', '0', { unit_of_measurement: 'kWh', friendly_name: 'SmartHub meter' })

  it('differences day-over-day maxima into per-day usage and skips the first (baseline) day', () => {
    const now = new Date(2026, 2, 2, 9) // 2 March 2026, 09:00 local
    const points = counterHistory(new Date(2026, 1, 1), 30, 12) // 1 Feb .. 2 Mar
    const device = summariseCounter(meter, points, now)

    expect(device.isBareCounter).toBe(true)
    expect(device.daily[0].day).toBe('2026-02-02')
    expect(device.daily.every((entry) => Math.abs(entry.kWh - 12) < 1e-9)).toBe(true)
  })

  it('separates this month from last across a month boundary', () => {
    const now = new Date(2026, 2, 2, 9) // 2 March
    const points = counterHistory(new Date(2026, 1, 1), 30, 12) // covers all 28 days of Feb plus 1-2 Mar
    const device = summariseCounter(meter, points, now)

    expect(device.yesterdayKWh).toBeCloseTo(12) // 1 March
    // 1 and 2 March; today is included in the month-to-date figure.
    expect(device.thisMonthKWh).toBeCloseTo(24)
    // 27 diffs inside February (the 1st is the baseline day), all 28 days observed.
    expect(device.lastMonthKWh).toBeCloseTo(27 * 12)
    // The 30-day comparison figure excludes today.
    expect(device.currentPeriodKWh).toBeCloseTo(28 * 12)
  })

  it('withholds a last-month total until most of that month has been seen', () => {
    const now = new Date(2026, 3, 20, 9) // 20 April: the 30-day window only reaches back to ~21 March
    const points = counterHistory(new Date(2026, 2, 21), 31, 5)
    const device = summariseCounter(meter, points, now)
    expect(device.lastMonthKWh).toBeNull()
    expect(device.thisMonthKWh).toBeCloseTo(20 * 5)
  })

  it('treats a counter reset as zero usage rather than a negative day', () => {
    const now = new Date(2026, 4, 3, 9)
    const points = [
      ...counterHistory(new Date(2026, 4, 1), 1, 10, 500),
      ...counterHistory(new Date(2026, 4, 2), 1, 10, 0), // meter replaced overnight
    ]
    const device = summariseCounter(meter, points, now)
    expect(device.daily).toEqual([{ day: '2026-05-02', kWh: 0 }])
  })

  it('converts Wh counters to kWh', () => {
    const whMeter = entity('sensor.plug', '0', { unit_of_measurement: 'Wh' })
    const now = new Date(2026, 4, 3, 9)
    const device = summariseCounter(whMeter, counterHistory(new Date(2026, 4, 1), 2, 3000, 0), now)
    expect(device.yesterdayKWh).toBeCloseTo(3)
  })

  it('returns an empty device when there is no history', () => {
    const device = summariseCounter(meter, [])
    expect(device).toMatchObject({ yesterdayKWh: null, thisMonthKWh: null, lastMonthKWh: null, currentPeriodKWh: 0, daily: [] })
    expect(device.name).toBe('SmartHub meter')
  })
})

describe('summariseDailyReset', () => {
  it('takes the peak reading per day, oldest first', () => {
    const points = [
      { time: new Date(2026, 0, 2, 6).getTime(), value: 1 },
      { time: new Date(2026, 0, 2, 22).getTime(), value: 7.5 },
      { time: new Date(2026, 0, 1, 23).getTime(), value: 4 },
      { time: new Date(2026, 0, 3, 0, 5).getTime(), value: 0.1 }, // just after the reset
    ]
    expect(summariseDailyReset(points, 'kWh')).toEqual([
      { day: '2026-01-01', kWh: 4 },
      { day: '2026-01-02', kWh: 7.5 },
      { day: '2026-01-03', kWh: 0.1 },
    ])
  })
})

describe('classifyEnergyEntities', () => {
  it('groups sibling period sensors, and separates bare counters and daily-reset sensors', () => {
    const entities = new Map<string, HAEntity>([
      ['sensor.washer_energy_yesterday', entity('sensor.washer_energy_yesterday', '1.5', { friendly_name: 'Washer Energy Yesterday' })],
      ['sensor.washer_energy_this_month', entity('sensor.washer_energy_this_month', '20')],
      ['sensor.washer_energy_last_month', entity('sensor.washer_energy_last_month', '25000', { unit_of_measurement: 'Wh' })],
      ['sensor.smarthub_meter', entity('sensor.smarthub_meter', '12345')],
      ['sensor.oven_energy_today', entity('sensor.oven_energy_today', '2')],
      ['sensor.not_energy', entity('sensor.not_energy', '1', { device_class: 'temperature' })],
    ])
    const result = classifyEnergyEntities(entities)
    expect(result.energyEntities).toHaveLength(5)
    expect(result.groupedDevices).toEqual([{
      id: 'sensor.washer', name: 'Washer', yesterdayKWh: 1.5, thisMonthKWh: 20, lastMonthKWh: 25, currentPeriodKWh: 20, isBareCounter: false, daily: [],
    }])
    expect(result.bareEntities.map((item) => item.entity_id)).toEqual(['sensor.smarthub_meter'])
    expect(result.todayEntities.map((item) => item.entity_id)).toEqual(['sensor.oven_energy_today'])
  })
})

describe('energySignature', () => {
  it('changes only when an energy reading changes', () => {
    const base = new Map<string, HAEntity>([['sensor.a', entity('sensor.a', '1')], ['sensor.t', entity('sensor.t', '70', { device_class: 'temperature' })]])
    const unrelated = new Map(base).set('sensor.t', entity('sensor.t', '71', { device_class: 'temperature' }))
    const changed = new Map(base).set('sensor.a', entity('sensor.a', '2'))
    expect(energySignature(unrelated)).toBe(energySignature(base))
    expect(energySignature(changed)).not.toBe(energySignature(base))
  })
})

describe('useEnergy', () => {
  it('fetches 30-day history for a bare counter once, and not again on unrelated state ticks', async () => {
    const start = new Date()
    start.setDate(start.getDate() - 29)
    const history = counterHistory(new Date(start.getFullYear(), start.getMonth(), start.getDate()), 30, 10)
      .map((point) => ({ state: String(point.value), last_changed: new Date(point.time).toISOString() }))
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      expect(String(input)).toContain('/api/history/sensor.smarthub_meter?hours=720')
      return Promise.resolve({ ok: true, json: () => Promise.resolve(history) } as Response)
    })
    vi.stubGlobal('fetch', fetchMock)

    const meter = entity('sensor.smarthub_meter', '999', { friendly_name: 'SmartHub meter' })
    const first = new Map<string, HAEntity>([['sensor.smarthub_meter', meter], ['sensor.t', entity('sensor.t', '70', { device_class: 'temperature' })]])
    const { result, rerender } = renderHook(({ entities }) => useEnergy(entities), { initialProps: { entities: first } })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.wholeHome?.id).toBe('sensor.smarthub_meter')
    expect(result.current.devices).toHaveLength(0)
    expect(result.current.daily.length).toBeGreaterThan(20)

    const resultBefore = result.current
    rerender({ entities: new Map(first).set('sensor.t', entity('sensor.t', '71', { device_class: 'temperature' })) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Memoised: a tick on an unrelated sensor hands back the very same result object.
    expect(result.current).toBe(resultBefore)
  })

  it('reports empty when no energy sensors exist', () => {
    const { result } = renderHook(() => useEnergy(new Map()))
    expect(result.current.isEmpty).toBe(true)
    expect(result.current.loading).toBe(false)
  })
})
