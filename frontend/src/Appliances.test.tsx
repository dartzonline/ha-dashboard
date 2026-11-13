import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCachedJson } from './cachedFetch'
import { DepartureCard } from './DepartureCard'
import { FridgePanel, HvacPanel } from './AppliancePanels'
import { departureStatus, efficiencyLabel, filterLabel, percentChange, type Departure } from './applianceFormat'

beforeEach(() => clearCachedJson())
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function stub(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const key = Object.keys(routes).find((path) => String(input).includes(path))
    return new Response(JSON.stringify(key ? routes[key] : {}), { status: init?.method === 'POST' && !key ? 404 : 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const LEAVE: Departure = {
  at: '2026-11-13T08:30:00-06:00', time: '8:30 am', day: 'tomorrow', hoursAway: 9, leavingNow: false, level: 22, levelAtDeparture: 22,
  rangeAtDeparture: 8, plugged: false, charging: false, target: 100, needsPlug: true, feelsLikeC: 1.5, feelsLike: 35, temperatureUnit: '°F', climate: 'warm',
}

describe('departure wording', () => {
  it('says what matters about the charge', () => {
    expect(departureStatus(LEAVE)).toEqual({ text: 'Plug in: it will still be at 22% when you leave.', tone: 'warn' })
    expect(departureStatus({ ...LEAVE, needsPlug: false, plugged: true, charging: true, levelAtDeparture: 100 }).text).toBe('Charging: full by then.')
    expect(departureStatus({ ...LEAVE, needsPlug: false, plugged: true, charging: true, levelAtDeparture: 70 }).text).toBe('Charging: about 70% by then.')
    expect(departureStatus({ ...LEAVE, needsPlug: false, levelAtDeparture: 80, level: 80 }).text).toMatch(/plenty/)
  })
})

describe('DepartureCard', () => {
  it('warns to plug in and starts the climate after a second tap', async () => {
    stub({ 'car/departure': { available: true, climateButton: 'button.car_start_climatization', departure: LEAVE } })
    const onService = vi.fn(async () => [])
    render(<DepartureCard onService={onService} />)
    expect(await screen.findByText('Leaving 8:30 am tomorrow')).toBeTruthy()
    expect(screen.getByText(/Plug in: it will still be at 22%/)).toBeTruthy()
    expect(screen.getByText(/Feels like 35°F at 8:30 am/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Warm up the car' }))
    expect(onService).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to start' }))
    expect(onService).toHaveBeenCalledWith('button', 'press', { entity_id: 'button.car_start_climatization' })
    expect(await screen.findByText('Climate started')).toBeTruthy()
  })

  it('renders nothing without a learned departure', async () => {
    stub({ 'car/departure': { available: true, departure: null } })
    const { container } = render(<DepartureCard onService={vi.fn()} />)
    await vi.waitFor(() => expect(container.textContent).toBe(''))
  })
})

describe('appliance panels', () => {
  it('labels', () => {
    expect(percentChange(0.018)).toBe('+2%')
    expect(efficiencyLabel({ status: 'longer', ratio: 1.4, matchedDays: 5, loggedDays: 40 })).toBe('Running 40% longer than in the same weather')
    expect(efficiencyLabel({ status: 'learning', ratio: null, matchedDays: 0, loggedDays: 10 })).toMatch(/^Learning: 10 days logged/)
    expect(filterLabel({ changedOn: '2026-08-01', days: 104, runHours: 236, runHoursComplete: false, status: 'due', dueInDays: -14 })).toBe('Changed 104 days ago · at least 236 h of running')
    expect(filterLabel(undefined)).toBe('Not recorded yet')
  })

  it('shows the fridge trend and its advice', async () => {
    stub({ 'insights/fridge': { available: true, status: 'ok', recentKwhPerDay: 2.21, usualKwhPerDay: 2.17, rise: 0.018, yearlyCost: 88, weeks: [], advice: ['The freezer is set to -4°F. 0 °F (-18 °C) keeps food safe and uses less.'] } })
    render(<FridgePanel />)
    expect(await screen.findByText('Normal')).toBeTruthy()
    expect(screen.getByText('2.17 kWh/day (+2%)')).toBeTruthy()
    expect(screen.getByText(/freezer is set to -4°F/)).toBeTruthy()
  })

  it('records a filter change after two taps', async () => {
    const fetchMock = stub({
      'insights/hvac': { available: true, days: [{ date: '2026-11-11', hours: 3, mode: 'cool', cycles: 11, outdoorF: 66 }], weekHours: 3, avgHoursPerDay: 3, cycleMinutes: 16, shortCycling: false,
        efficiency: { status: 'learning', ratio: null, matchedDays: 0, loggedDays: 10 }, filter: { changedOn: null, days: null, runHours: null, status: 'unknown', dueInDays: null }, advice: [] },
      'maintenance/hvac-filter': { filter: { changedOn: '2026-11-13', days: 0, runHours: 0, status: 'ok', dueInDays: 90 } },
    })
    render(<HvacPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'I changed the filter today' }))
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to confirm' }))
    expect(await screen.findByText('Filter changed today')).toBeTruthy()
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('maintenance/hvac-filter') && init?.method === 'POST')).toBe(true)
  })
})
