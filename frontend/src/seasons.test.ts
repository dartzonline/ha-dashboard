import { describe, expect, it } from 'vitest'
import { christmasCountdown, seasonalWeather, seasonForDate } from './seasons'
import type { HAEntity } from './types'

const day = (month: number, date: number) => new Date(2026, month - 1, date, 12)

function weather(state: string, attributes: Record<string, unknown>): Map<string, HAEntity> {
  const entity = { entity_id: 'weather.forecast_home', state, attributes, last_changed: '', last_updated: '' }
  return new Map([[entity.entity_id, entity]])
}

describe('seasonForDate', () => {
  it('runs Halloween through October, Fall through November and Holidays to Epiphany', () => {
    expect(seasonForDate(day(9, 30))).toBeNull()
    expect(seasonForDate(day(10, 1))).toBe('halloween')
    expect(seasonForDate(day(10, 31))).toBe('halloween')
    expect(seasonForDate(day(11, 1))).toBe('fall')
    expect(seasonForDate(day(11, 30))).toBe('fall')
    expect(seasonForDate(day(12, 1))).toBe('holidays')
    expect(seasonForDate(new Date(2027, 0, 6, 23))).toBe('holidays')
    expect(seasonForDate(new Date(2027, 0, 7))).toBeNull()
    expect(seasonForDate(day(6, 15))).toBeNull()
  })
})

describe('christmasCountdown', () => {
  it('stays quiet in November and counts down from December 1', () => {
    expect(christmasCountdown(day(11, 30))).toBeNull()
    expect(christmasCountdown(day(12, 1))).toBe('24 sleeps to Christmas')
    expect(christmasCountdown(day(12, 13))).toBe('12 sleeps to Christmas')
    expect(christmasCountdown(day(12, 24))).toBe('Christmas Eve · 1 sleep to go')
    expect(christmasCountdown(day(12, 25))).toBe('Merry Christmas')
    expect(christmasCountdown(day(12, 26))).toBeNull()
  })
})

describe('seasonalWeather', () => {
  it('reads Fahrenheit, mph and a westerly wind as rightward', () => {
    const reading = seasonalWeather(weather('snowy', { temperature: 23, temperature_unit: '°F', wind_speed: 10, wind_speed_unit: 'mph', wind_bearing: 270 }))
    expect(reading.tempC).toBeCloseTo(-5)
    expect(reading.windKmh).toBeCloseTo(16.09, 1)
    expect(reading.windX).toBeCloseTo(1)
    expect(reading.snowing).toBe(true)
  })

  it('treats a missing weather entity as calm', () => {
    expect(seasonalWeather(new Map())).toEqual({ tempC: null, windKmh: 0, windX: 0, snowing: false, raining: false, condition: null })
  })
})
