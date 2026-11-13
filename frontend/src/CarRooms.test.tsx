import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCachedJson } from './cachedFetch'
import { CarWeekPanel } from './CarWeek'
import { RoomBalancePanel } from './RoomBalance'
import { balanceHeadline, fullChargeHours, signed, windowLabel, type BalancedRoom, type CarWeekData } from './carRoomsFormat'

beforeEach(() => clearCachedJson())
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function stub(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))))
}

const CAR: CarWeekData = {
  available: true, since: new Date(2026, 10, 11, 0, 0).toISOString(), days: 2, charges: 2, kwh: 19.2, cost: 2.1, rate: 0.109,
  fullChargeCost: 1.91, typicalKw: 1.4, level1: true, miles: 108, electricMiles: 80, electricShare: 0.74, gallons: 1.1, gasMpg: 25.5,
  sessions: [
    { start: new Date(2026, 10, 11, 21, 0).toISOString(), end: new Date(2026, 10, 12, 5, 0).toISOString(), fromPct: 2, toPct: 100, kwh: 17.1, kw: 1.3, cost: 1.87 },
    { start: new Date(2026, 10, 12, 15, 0).toISOString(), end: new Date(2026, 10, 12, 17, 0).toISOString(), fromPct: 53, toPct: 65, kwh: 2.1, kw: 1.4, cost: 0.23 },
  ],
}

describe('car week', () => {
  it('labels a short history and works out a full charge time', () => {
    expect(windowLabel(CAR)).toMatch(/^since /)
    expect(windowLabel({ ...CAR, days: 7 })).toBe('last 7 days')
    expect(fullChargeHours(CAR)).toBeCloseTo(1.91 / 0.109 / 1.4)
  })

  it('shows cost, electric share and sessions, newest first', async () => {
    stub(CAR)
    render(<CarWeekPanel />)
    expect(await screen.findByText('74%')).toBeTruthy()
    expect(screen.getByText('2 times')).toBeTruthy()
    expect(screen.getByText(/80 of 108 mi/)).toBeTruthy()
    expect(screen.getByText(/standard wall outlet/)).toBeTruthy()
    const rows = screen.getAllByRole('listitem')
    expect(rows[0].textContent).toContain('53% → 65%')
  })

  it('renders nothing without a car', async () => {
    stub({ available: false })
    const { container } = render(<CarWeekPanel />)
    await vi.waitFor(() => expect(container.textContent).toBe(''))
  })
})

const room = (over: Partial<BalancedRoom>): BalancedRoom => ({
  entityId: 'sensor.x', label: 'X', current: 70, offset: 0, parts: { night: 0, morning: 0, afternoon: 0, evening: 0 },
  worstPart: null, worst: 0, status: 'balanced', strong: false, advice: 'Stays within 2° of the thermostat.', ...over,
})

describe('room balance', () => {
  it('formats signed offsets', () => {
    expect(signed(-3.94)).toBe('−3.9°')
    expect(signed(2)).toBe('+2.0°')
    expect(signed(0.01)).toBe('±0.0°')
  })

  it('headlines the rooms that stand out and ignores stuck sensors', () => {
    const rooms = [room({ label: 'Media', status: 'cool', offset: -3.9 }), room({ label: 'Guest', status: 'stale', offset: 3.8 })]
    expect(balanceHeadline(rooms)).toBe('Media runs 4° cooler')
    expect(balanceHeadline([room({})])).toBe('Every room stays close to the thermostat')
  })

  it('lists rooms with their advice and highlights the worst time of day', async () => {
    stub({
      days: 7, unit: '°F', spread: 2.6, reference: { entityId: 'sensor.t', label: 'Hall Thermostat', current: 71 },
      rooms: [room({ entityId: 'sensor.media', label: 'Media', status: 'cool', offset: -3.9, worstPart: 'morning', parts: { night: -5.6, morning: -6.8, afternoon: -1, evening: -2.4 }, advice: 'Coldest in the morning: check for a closed vent or a draughty window.' })],
    })
    render(<RoomBalancePanel />)
    expect(await screen.findByText(/Coldest in the morning/)).toBeTruthy()
    expect(screen.getByText('vs Hall Thermostat')).toBeTruthy()
    expect(screen.getByText('−6.8°').className).toContain('is-worst')
  })
})
