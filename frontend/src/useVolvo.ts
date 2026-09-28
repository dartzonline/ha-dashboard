import { useMemo } from 'react'
import { friendlyName as baseFriendlyName } from './entityNames'
import type { HAEntity } from './types'

/**
 * Scans live entities for anything belonging to the car, the same zero-config pattern EnergyView
 * and PresenceRow already use — no dashboardConfig.ts edit needed when Home Assistant's Volvo
 * integration adds or renames a sensor.
 */
export interface VolvoMetric {
  entityId: string
  label: string
  value: string
  raw: number | null
  unit: string
  icon: 'battery' | 'gauge' | 'thermometer' | 'droplets' | 'wind' | 'car'
}

export interface VolvoBinary {
  entityId: string
  label: string
  on: boolean
  domain: string
}

export interface VolvoCar {
  deviceName: string
  metrics: VolvoMetric[]
  binaries: VolvoBinary[]
  batteryMetric: VolvoMetric | null
  rangeMetric: VolvoMetric | null
  odometerMetric: VolvoMetric | null
  locked: VolvoBinary | null
  updatedAt: string | null
}

const LABEL_ICON_RULES: Array<[RegExp, VolvoMetric['icon']]> = [
  [/batt|charg|soc/i, 'battery'],
  [/range|distance_to_empty/i, 'gauge'],
  [/odometer|mileage/i, 'gauge'],
  [/tyre|tire|pressure/i, 'gauge'],
  [/temp/i, 'thermometer'],
  [/fuel/i, 'droplets'],
  [/wind|speed/i, 'wind'],
]

const metricFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

function iconFor(entityId: string): VolvoMetric['icon'] {
  const match = LABEL_ICON_RULES.find(([pattern]) => pattern.test(entityId))
  return match ? match[1] : 'car'
}

function friendlyName(entity: HAEntity) {
  const name = baseFriendlyName(entity)
  return name.replace(/^Volvo\s*(XC\d+)?\s*/i, '').replaceAll('_', ' ').trim() || name
}

function guessDeviceName(entities: HAEntity[]) {
  for (const entity of entities) {
    const match = baseFriendlyName(entity, '').match(/Volvo\s+\w+/i)
    if (match) return match[0]
  }
  const model = entities[0]?.entity_id.match(/volvo_([a-z0-9]+)/i)?.[1]
  return model ? `Volvo ${model.toUpperCase()}` : 'Volvo'
}

/** Picks the most-relevant match by priority so "battery" doesn't grab a diagnostic side sensor. */
function findMetric(metrics: VolvoMetric[], pattern: RegExp) {
  return metrics.find((metric) => pattern.test(metric.entityId)) ?? null
}

function isVolvoEntity(entity: HAEntity) {
  return entity.entity_id.toLowerCase().includes('volvo')
}

/**
 * One string that changes exactly when the car's data does. Every WebSocket frame replaces the
 * entities Map, so memoising on the Map itself never hit; keyed on this, the summary below is
 * rebuilt only when a Volvo entity actually changes.
 */
export function volvoSignature(entities: Map<string, HAEntity>) {
  const parts: string[] = []
  for (const entity of entities.values()) {
    if (isVolvoEntity(entity)) parts.push(`${entity.entity_id}=${entity.state}@${entity.last_changed}`)
  }
  return parts.join('|')
}

export function summariseVolvo(entities: Map<string, HAEntity>): VolvoCar | null {
  const matches = Array.from(entities.values()).filter(isVolvoEntity)
  if (matches.length === 0) return null

  const metrics: VolvoMetric[] = []
  const binaries: VolvoBinary[] = []
  let updatedAt: string | null = null

  for (const entity of matches) {
    const domain = entity.entity_id.split('.')[0]
    if (entity.last_changed && (!updatedAt || entity.last_changed > updatedAt)) updatedAt = entity.last_changed

    if (domain === 'sensor') {
      const raw = Number(entity.state)
      if (!Number.isFinite(raw)) continue
      const unit = typeof entity.attributes.unit_of_measurement === 'string' ? entity.attributes.unit_of_measurement : ''
      metrics.push({
        entityId: entity.entity_id,
        label: friendlyName(entity),
        value: `${metricFormat.format(raw)}${unit ? ` ${unit}` : ''}`,
        raw,
        unit,
        icon: iconFor(entity.entity_id),
      })
    } else if (domain === 'binary_sensor' || domain === 'lock') {
      const on = domain === 'lock' ? entity.state === 'locked' : entity.state === 'on'
      binaries.push({ entityId: entity.entity_id, label: friendlyName(entity), on, domain })
    }
  }

  metrics.sort((a, b) => a.label.localeCompare(b.label))

  return {
    deviceName: guessDeviceName(matches),
    metrics,
    binaries,
    batteryMetric: findMetric(metrics, /batt|soc/i),
    rangeMetric: findMetric(metrics, /range|distance_to_empty/i),
    odometerMetric: findMetric(metrics, /odometer|mileage/i),
    locked: binaries.find((item) => item.domain === 'lock') ?? null,
    updatedAt,
  }
}

export function useVolvo(entities: Map<string, HAEntity>): VolvoCar | null {
  const signature = volvoSignature(entities)
  // `entities` is deliberately not a dependency: the signature already encodes every field read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => summariseVolvo(entities), [signature])
}
