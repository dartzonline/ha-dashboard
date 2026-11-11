import { describe, expect, it } from 'vitest'
import { isMorning, MORNING_REPEAT_MS, nextRotationSection } from './morningRotation'

const at = (hour: number, minute = 0) => new Date(2026, 10, 10, hour, minute)
const sections = ['morning', 'insights', 'home', 'health']

describe('morning rotation', () => {
  it('treats 5 am to 11 am as the morning', () => {
    expect(isMorning(at(4, 59))).toBe(false)
    expect(isMorning(at(5))).toBe(true)
    expect(isMorning(at(10, 59))).toBe(true)
    expect(isMorning(at(11))).toBe(false)
  })

  it('skips Morning outside the morning', () => {
    expect(nextRotationSection(sections, 'health', at(14), null)).toBe('insights')
    expect(nextRotationSection(sections, 'morning', at(14), null)).toBe('insights')
  })

  it('goes to Morning first in the morning, then every half hour', () => {
    expect(nextRotationSection(sections, 'home', at(7), null)).toBe('morning')
    const shown = at(7).getTime()
    expect(nextRotationSection(sections, 'morning', at(7, 2), shown)).toBe('insights')
    expect(nextRotationSection(sections, 'home', at(7, 10), shown)).toBe('health')
    expect(nextRotationSection(sections, 'home', new Date(shown + MORNING_REPEAT_MS), shown)).toBe('morning')
  })

  it('works when the layout has no Morning page', () => {
    expect(nextRotationSection(['home', 'health'], 'home', at(7), null)).toBe('health')
  })
})
