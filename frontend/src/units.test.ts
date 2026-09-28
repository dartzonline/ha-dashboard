import { describe, expect, it } from 'vitest'
import { KIB_PER_SEC_TO_MBPS, displayUnit, formatNumber, isThroughputUnit, toMbps } from './units'

describe('toMbps', () => {
  it('converts KiB/s with the decimal-megabit factor, not the mebibit one', () => {
    // 1000 KiB/s = 1,024,000 bytes/s = 8,192,000 bit/s = 8.192 Mbps. The old x8/1024 gave 7.8125.
    expect(toMbps(1000, 'KiB/s')).toBeCloseTo(8.192, 6)
    expect(KIB_PER_SEC_TO_MBPS).toBeCloseTo(0.008192, 9)
  })

  it.each([
    [1, 'MB/s', 8],
    [1, 'MiB/s', 8.388608],
    [1_000_000, 'B/s', 8],
    [1000, 'kbit/s', 1],
    [5, 'Mbit/s', 5],
    [5, 'Mbps', 5],
    [1, 'Gbps', 1000],
  ])('converts %s %s to %s Mbps', (value, unit, expected) => {
    expect(toMbps(value, unit)).toBeCloseTo(expected, 6)
  })

  it('passes unknown or missing units through unchanged', () => {
    expect(toMbps(42, undefined)).toBe(42)
    expect(toMbps(42, null)).toBe(42)
    expect(toMbps(42, '°F')).toBe(42)
  })
})

describe('units helpers', () => {
  it('recognises throughput units and relabels them as Mbps', () => {
    expect(isThroughputUnit('KiB/s')).toBe(true)
    expect(isThroughputUnit('%')).toBe(false)
    expect(displayUnit('KiB/s')).toBe('Mbps')
    expect(displayUnit('%')).toBe('%')
  })

  it('formats with the requested precision', () => {
    expect(formatNumber(1234.567)).toBe(new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(1234.567))
    expect(formatNumber(1.25, 1)).toBe(new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(1.25))
  })
})
