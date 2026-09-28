import { describe, expect, it } from 'vitest'
import { comfortScore, historyWindowLabel } from './insightDetails'

describe('comfortScore', () => {
  it('is 100 at the 72°F / 45% target', () => {
    expect(comfortScore(72, 45)).toBe(100)
  })

  it('loses 4 points per degree and 0.8 per humidity point, in either direction', () => {
    expect(comfortScore(75, 45)).toBe(88)
    expect(comfortScore(69, 45)).toBe(88)
    expect(comfortScore(72, 55)).toBe(92)
    expect(comfortScore(72, 35)).toBe(92)
    expect(comfortScore(74, 50)).toBe(88)
  })

  it('never leaves 0..100 and rounds to a whole number', () => {
    expect(comfortScore(120, 100)).toBe(0)
    expect(comfortScore(-40, 0)).toBe(0)
    expect(Number.isInteger(comfortScore(72.3, 45.7))).toBe(true)
  })
})

describe('historyWindowLabel', () => {
  it('names the window by its length', () => {
    expect(historyWindowLabel(24)).toBe('Last 24 hours')
    expect(historyWindowLabel(24 * 7)).toBe('Last 7 days')
    expect(historyWindowLabel(24 * 30)).toBe('Last 30 days')
  })
})
