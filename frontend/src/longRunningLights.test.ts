import { describe, expect, it } from 'vitest'
import { lightWarnAfterMs, longRunningLights } from './longRunningLights'
import type { HAEntity } from './types'

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0)
const MINUTE = 60_000

function light(entityId: string, onForMinutes: number, attributes: Record<string, unknown> = {}): HAEntity {
  const changed = new Date(NOW - onForMinutes * MINUTE).toISOString()
  return { entity_id: entityId, state: 'on', attributes, last_changed: changed, last_updated: changed }
}

const defaults = { minutes: 240, excludedIds: ['light.my_rest_clock'] }

describe('longRunningLights', () => {
  it('flags lights on for two hours and skips excluded and landscape lights', () => {
    const found = longRunningLights(
      [light('light.kitchen', 130), light('light.my_rest_clock', 600), light('light.landscape_path', 600), light('light.hall', 30)],
      NOW,
      defaults,
    )
    expect(found.map((item) => item.entity.entity_id)).toEqual(['light.kitchen'])
  })

  it('lets the household remove the default exclusion', () => {
    const found = longRunningLights([light('light.my_rest_clock', 600)], NOW, { minutes: 240, excludedIds: [] })
    expect(found).toHaveLength(1)
  })

  it('warns halfway to a short switch-off time', () => {
    expect(lightWarnAfterMs(240)).toBe(120 * MINUTE)
    expect(lightWarnAfterMs(30)).toBe(15 * MINUTE)
    const found = longRunningLights([light('light.kitchen', 20)], NOW, { minutes: 30, excludedIds: [] })
    expect(found).toHaveLength(1)
  })
})
