import { describe, expect, it } from 'vitest'
import { classify, deviceIdsOwningDomain } from './entityClassifier'
import type { RegistryMeta, RegistrySnapshot } from './entityClassifier'
import { friendlyName } from './entityNames'
import type { HAEntity } from './types'

function entity(entityId: string, attributes: Record<string, unknown> = {}, state = 'on'): HAEntity {
  return { entity_id: entityId, state, attributes, last_changed: '', last_updated: '' }
}

function meta(overrides: Partial<RegistryMeta> = {}): RegistryMeta {
  return { areaId: null, category: null, disabled: false, hidden: false, deviceId: null, ...overrides }
}

describe('classify', () => {
  it.each<[string, HAEntity, RegistryMeta | undefined, string]>([
    ['a light becomes a lights toggle', entity('light.kitchen', { friendly_name: 'Kitchen' }), undefined, 'lights/toggle'],
    ['a lock goes to security', entity('lock.front_door'), undefined, 'security/lock'],
    ['a thermostat goes to climate', entity('climate.hall'), undefined, 'climate/thermostat'],
    ['a vacuum goes to roborock', entity('vacuum.robot'), undefined, 'roborock/vacuum'],
    ['a media player is an appliance toggle', entity('media_player.tv'), undefined, 'appliances/toggle'],
    ['a scene lands in scenes', entity('scene.movie'), undefined, 'scenes/sensor'],
    ['a garage cover reads as security', entity('cover.garage_door', { device_class: 'garage' }), undefined, 'security/sensor'],
    ['a blind is a lighting concern', entity('cover.living_room_blind'), undefined, 'lights/toggle'],
    ['a door sensor goes to security', entity('binary_sensor.back_door', { device_class: 'door' }), undefined, 'security/sensor'],
    ['a leak sensor goes to security', entity('binary_sensor.sink', { device_class: 'moisture' }), undefined, 'security/sensor'],
    ['motion goes to security', entity('binary_sensor.hall_motion', { device_class: 'motion' }), undefined, 'security/sensor'],
    ['a lamp-named switch is a light', entity('switch.porch_lamp'), undefined, 'lights/toggle'],
    ['a washer-named switch is an appliance', entity('switch.washer_power'), undefined, 'appliances/toggle'],
    ['a temperature sensor goes to climate', entity('sensor.attic', { device_class: 'temperature' }), undefined, 'climate/sensor'],
    ['a humidity sensor goes to climate', entity('sensor.attic_rh', { device_class: 'humidity' }), undefined, 'climate/sensor'],
  ])('%s', (_name, candidate, registry, expected) => {
    const result = classify(candidate, registry)
    expect(result).not.toBe('skip')
    expect(result).not.toBe('review')
    if (typeof result === 'object') expect(`${result.sectionId}/${result.kind}`).toBe(expected)
  })

  it.each<[string, HAEntity, RegistryMeta | undefined]>([
    ['disabled registry entries', entity('light.old'), meta({ disabled: true })],
    ['hidden registry entries', entity('light.old'), meta({ hidden: true })],
    ['diagnostic entities', entity('sensor.wifi_signal'), meta({ category: 'diagnostic' })],
    ['config entities', entity('switch.child_lock'), meta({ category: 'config' })],
    ['people', entity('person.anil'), undefined],
    ['device trackers', entity('device_tracker.phone'), undefined],
    ['energy sensors, which EnergyView owns', entity('sensor.washer_energy', { device_class: 'energy' }), undefined],
    ['battery sensors, which Insights owns', entity('sensor.phone_battery', { device_class: 'battery' }), undefined],
    ['automations', entity('automation.night'), undefined],
    ['helpers', entity('input_boolean.guest_mode'), undefined],
    ['weather, which WeatherView owns', entity('weather.home'), undefined],
  ])('skips %s', (_name, candidate, registry) => {
    expect(classify(candidate, registry)).toBe('skip')
  })

  it.each<[string, HAEntity]>([
    ['a binary sensor of unknown class', entity('binary_sensor.mystery')],
    ['a switch with no naming hint', entity('switch.relay_2')],
    ['a sensor with no device class', entity('sensor.something')],
    ['an unfamiliar domain', entity('siren.alarm')],
  ])('sends %s to review rather than guessing', (_name, candidate) => {
    expect(classify(candidate, undefined)).toBe('review')
  })

  it('files a vacuum device\'s sensors and switches under roborock', () => {
    const vacuumDevices = new Set(['dev-vac'])
    const sensor = classify(entity('sensor.robot_filter_left'), meta({ deviceId: 'dev-vac' }), vacuumDevices)
    const toggle = classify(entity('switch.robot_dnd'), meta({ deviceId: 'dev-vac' }), vacuumDevices)
    expect(sensor).toMatchObject({ sectionId: 'roborock', kind: 'sensor', icon: 'filter' })
    expect(toggle).toMatchObject({ sectionId: 'roborock', kind: 'toggle', icon: 'bot' })
  })

  it('skips companion-app telemetry once its device is known to own a tracker', () => {
    const phones = new Set(['dev-phone'])
    expect(classify(entity('sensor.phone_steps'), meta({ deviceId: 'dev-phone' }), new Set(), phones)).toBe('skip')
  })

  it('labels proposals with the friendly name, falling back to the spaced object id', () => {
    expect(classify(entity('light.kitchen_island', { friendly_name: 'Island pendants' }), undefined)).toMatchObject({ label: 'Island pendants' })
    expect(classify(entity('light.kitchen_island'), undefined)).toMatchObject({ label: 'kitchen island' })
  })
})

describe('deviceIdsOwningDomain', () => {
  const registry: RegistrySnapshot = {
    entities: {
      'vacuum.robot': meta({ deviceId: 'dev-vac' }),
      'sensor.robot_filter': meta({ deviceId: 'dev-vac' }),
      'light.kitchen': meta({ deviceId: 'dev-light' }),
    },
    areas: {},
  }

  it('collects the device ids behind entities of a domain', () => {
    const ids = deviceIdsOwningDomain([entity('vacuum.robot'), entity('light.kitchen')], registry, 'vacuum')
    expect([...ids]).toEqual(['dev-vac'])
  })

  it('is empty without a registry', () => {
    expect(deviceIdsOwningDomain([entity('vacuum.robot')], null, 'vacuum').size).toBe(0)
  })
})

describe('friendlyName', () => {
  it('prefers the friendly name, then the caller fallback, then the spaced object id', () => {
    expect(friendlyName(entity('sensor.a_b', { friendly_name: 'Nice' }))).toBe('Nice')
    expect(friendlyName(entity('sensor.a_b', { friendly_name: '  ' }), 'Fallback')).toBe('Fallback')
    expect(friendlyName(entity('sensor.a_b'))).toBe('a b')
    expect(friendlyName(undefined, 'None')).toBe('None')
  })
})
