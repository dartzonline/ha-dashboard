/** Types and wording shared by the car-week and room-balance panels (kept apart for fast refresh). */

export interface ChargeSession {
  start: string
  end: string
  fromPct: number
  toPct: number
  kwh: number
  kw: number | null
  cost: number
}

export interface CarWeekData {
  available: boolean
  since?: string | null
  days?: number
  sessions?: ChargeSession[]
  charges?: number
  kwh?: number
  cost?: number
  rate?: number
  fullChargeCost?: number | null
  typicalKw?: number | null
  level1?: boolean
  miles?: number
  electricMiles?: number | null
  electricShare?: number | null
  gallons?: number
  gasMpg?: number | null
}

/** "last 7 days", or "since Wed, Nov 11" while the car's history is still shorter than a week. */
export function windowLabel(data: CarWeekData) {
  if (!data.since || (data.days ?? 0) >= 6.5) return 'last 7 days'
  return `since ${new Date(data.since).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`
}

/** Hours for an empty-to-full charge at the car's usual charging speed. */
export function fullChargeHours(data: CarWeekData) {
  if (!data.fullChargeCost || !data.rate || !data.typicalKw) return null
  return data.fullChargeCost / data.rate / data.typicalKw
}

export type RoomStatus = 'warm' | 'cool' | 'balanced' | 'stale'

export interface BalancedRoom {
  entityId: string
  label: string
  current: number | null
  offset: number
  parts: Partial<Record<'night' | 'morning' | 'afternoon' | 'evening', number>>
  worstPart: string | null
  worst: number
  status: RoomStatus
  strong: boolean
  advice: string
}

export interface RoomBalanceData {
  days: number
  unit: string | null
  reference: { entityId: string | null; label: string; current: number | null } | null
  spread: number | null
  rooms: BalancedRoom[]
}

export function signed(value: number) {
  const rounded = Math.round(value * 10) / 10
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : '±'}${Math.abs(rounded).toFixed(1)}°`
}

/** The headline: which rooms stand out, in a few words. */
export function balanceHeadline(rooms: BalancedRoom[]) {
  const off = rooms.filter((room) => room.status === 'warm' || room.status === 'cool')
  if (off.length === 0) return 'Every room stays close to the thermostat'
  return off.slice(0, 2).map((room) => `${room.label} runs ${Math.abs(room.offset).toFixed(0)}° ${room.status === 'warm' ? 'warmer' : 'cooler'}`).join(' · ')
}
