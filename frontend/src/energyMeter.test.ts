import { describe, expect, it } from 'vitest'
import { findWholeHomeMeter, meterCandidates } from './energyMeter'
import type { HAEntity } from './types'

const energy = (entityId: string, name: string) =>
  [entityId, { entity_id: entityId, state: '10', attributes: { device_class: 'energy', friendly_name: name } } as unknown as HAEntity] as const

const entities = new Map<string, HAEntity>([
  energy('sensor.refrigerator_energy_this_month', 'Refrigerator energy'),
  energy('sensor.refrigerator_energy_yesterday', 'Refrigerator yesterday'),
  energy('sensor.utility_monthly_usage', 'Utility meter'),
])

describe('whole-home meter', () => {
  it('finds a utility meter by name, and skips daily counters as candidates', () => {
    expect(findWholeHomeMeter(entities)).toBe('sensor.utility_monthly_usage')
    expect(meterCandidates(entities).map((entity) => entity.entity_id)).not.toContain('sensor.refrigerator_energy_yesterday')
  })

  it('prefers the household choice while it exists', () => {
    expect(findWholeHomeMeter(entities, 'sensor.refrigerator_energy_this_month')).toBe('sensor.refrigerator_energy_this_month')
    expect(findWholeHomeMeter(entities, 'sensor.gone')).toBe('sensor.utility_monthly_usage')
  })
})
