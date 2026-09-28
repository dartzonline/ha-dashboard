import { describe, expect, it } from 'vitest'
import { solarDeclination, terminatorPath } from './daylight'

describe('solarDeclination', () => {
  it('tilts north in June and south in December, near zero at the equinoxes', () => {
    expect(solarDeclination(new Date('2026-06-21T12:00:00Z'))).toBeGreaterThan(23)
    expect(solarDeclination(new Date('2026-12-21T12:00:00Z'))).toBeLessThan(-23)
    expect(Math.abs(solarDeclination(new Date('2026-03-20T12:00:00Z')))).toBeLessThan(1.5)
    expect(Math.abs(solarDeclination(new Date('2026-09-22T12:00:00Z')))).toBeLessThan(1.5)
  })
})

describe('terminatorPath', () => {
  function yValues(path: string) {
    return [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((match) => Number(match[2]))
  }

  it('is a closed path spanning three world widths', () => {
    const path = terminatorPath(new Date('2026-08-04T12:00:00Z'))
    expect(path.startsWith('M')).toBe(true)
    expect(path.endsWith('Z')).toBe(true)
    // -540..540 in 3-degree steps, plus the two closing corners.
    expect(yValues(path)).toHaveLength(361 + 2)
  })

  it('closes night to the south edge in northern summer and the north edge in winter', () => {
    expect(terminatorPath(new Date('2026-07-01T12:00:00Z'))).toMatch(/ 500 L-?[\d.]+ 500 Z$/)
    expect(terminatorPath(new Date('2026-01-01T12:00:00Z'))).toMatch(/ 0 L-?[\d.]+ 0 Z$/)
  })

  it('keeps every curve point inside the 1000x500 map', () => {
    for (const iso of ['2026-03-20T00:00:00Z', '2026-06-21T06:00:00Z', '2026-12-21T18:00:00Z']) {
      const ys = yValues(terminatorPath(new Date(iso)))
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...ys)).toBeLessThanOrEqual(500)
    }
  })

  it('does not blow up at the equinox, where the true terminator is a meridian', () => {
    const ys = yValues(terminatorPath(new Date('2026-03-20T14:45:00Z')))
    expect(ys.every(Number.isFinite)).toBe(true)
  })

  it('places the subsolar point at noon UTC on the prime meridian', () => {
    // At 12:00 UTC the sun is over 0° longitude; the curve is symmetric about x=500 (lon 0), so the
    // point at lon 0 and the points at ±180 sit at opposite extremes of the curve.
    const path = terminatorPath(new Date('2026-06-21T12:00:00Z'))
    const points = [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((match) => [Number(match[1]), Number(match[2])] as const)
    const atZero = points.find(([x]) => Math.abs(x - 500) < 0.6)!
    const atAnti = points.find(([x]) => Math.abs(x - 1000) < 0.6)!
    expect(atZero[1]).not.toBeCloseTo(atAnti[1], 0)
  })
})
