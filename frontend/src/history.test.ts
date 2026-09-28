import { describe, expect, it } from 'vitest'
import { downsample, historyPath, parseHistoryRecords, parseHistoryStates, unwrapHistoryPayload } from './history'

const records = [
  { state: '71.2', last_changed: '2026-08-01T00:00:00Z' },
  { state: 'unavailable', last_changed: '2026-08-01T00:10:00Z' },
  { state: '', last_changed: '2026-08-01T00:15:00Z' },
  { state: '72', last_updated: '2026-08-01T00:20:00Z' },
  { state: '73', last_changed: 'not a date' },
  null,
  'garbage',
]

describe('history payload parsing', () => {
  it('unwraps both the flat and the recorder-nested shapes', () => {
    expect(unwrapHistoryPayload(records)).toHaveLength(5)
    expect(unwrapHistoryPayload([records])).toHaveLength(5)
    expect(unwrapHistoryPayload({ not: 'a list' })).toEqual([])
    expect(unwrapHistoryPayload(undefined)).toEqual([])
  })

  it('keeps only finite numeric samples with a usable timestamp', () => {
    expect(parseHistoryStates([records])).toEqual([
      { time: Date.parse('2026-08-01T00:00:00Z'), value: 71.2 },
      { time: Date.parse('2026-08-01T00:20:00Z'), value: 72 },
    ])
  })

  it('does not read a blank state as zero', () => {
    // Number('') is 0, which used to draw a phantom dip in every chart at each recorder gap.
    expect(parseHistoryStates([{ state: '', last_changed: '2026-08-01T00:00:00Z' }])).toEqual([])
  })

  it('keeps text states for timelines, dropping only records with no timestamp', () => {
    expect(parseHistoryRecords(records).map((record) => record.state)).toEqual(['71.2', 'unavailable', '', '72'])
  })

  it('builds one canonical path so equal requests share a cache entry', () => {
    expect(historyPath('sensor.x')).toBe('history/sensor.x?hours=24')
    expect(historyPath('sensor.x', 720)).toBe('history/sensor.x?hours=720')
  })

  it('downsamples evenly while always keeping the final point', () => {
    const points = Array.from({ length: 100 }, (_, index) => index)
    const kept = downsample(points, 10)
    expect(kept.length).toBeLessThanOrEqual(11)
    expect(kept[0]).toBe(0)
    expect(kept[kept.length - 1]).toBe(99)
    expect(downsample([1, 2, 3], 48)).toEqual([1, 2, 3])
  })
})
