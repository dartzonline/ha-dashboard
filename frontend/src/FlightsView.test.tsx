import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlightsView } from './FlightsView'
import type { HAEntity } from './types'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** No home coordinates: the Track page under test polls /track only, never the radar. */
const NO_ENTITIES = new Map<string, HAEntity>()

function flight(callsign: string, overrides: Record<string, unknown> = {}) {
  return {
    query: callsign,
    mode: 'track',
    flight: {
      icao24: callsign.toLowerCase(),
      callsign,
      airline: 'Southwest',
      airlineCode: 'WN',
      type: 'B738',
      kind: 'jet',
      altitudeFt: 34_000,
      speedKt: 430,
      trackDeg: 95,
      distanceKm: 120,
      onGround: false,
      verticalRateFpm: 0,
      lat: 31.5,
      lon: -104.2,
    },
    route: {
      fromCode: 'LAX', fromCity: 'Los Angeles', fromLat: 33.94, fromLon: -118.41,
      toCode: 'AUS', toCity: 'Austin', toLat: 30.19, toLon: -97.67,
    },
    schedule: {},
    progress: 0.5,
    etaLine: 'ETA ~6:20 PM · 84 min left',
    ...overrides,
  }
}

function mockTrack(flights: unknown[]) {
  const board = flights.length > 0 ? { ...(flights[0] as object), flights } : { query: null, mode: null, flight: null, route: null, schedule: {}, progress: 0, etaLine: null, flights: [] }
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (!url.includes('flights/track')) throw new Error(`Unexpected fetch: ${url}`)
    return Promise.resolve({ ok: true, json: () => Promise.resolve(board) } as Response)
  }))
}

describe('Track page', () => {
  it('gives every tracked flight its own card, not just the first one', async () => {
    // The reported bug: three pinned flights produced one detail card and two one-line rows.
    mockTrack([flight('SWA771'), flight('AAL42'), flight('DAL9')])
    render(<FlightsView entities={NO_ENTITIES} slide={1} onSelectSlide={() => {}} />)

    await waitFor(() => expect(document.querySelectorAll('.track-card')).toHaveLength(3))
    // getAllByText, because the flight currently on the map is also named in the map's own chip.
    for (const callsign of ['SWA771', 'AAL42', 'DAL9']) {
      expect(screen.getAllByText(callsign).length).toBeGreaterThan(0)
    }
  })

  it('shows the route map in place of the aircraft showcase once a flight is being tracked', async () => {
    mockTrack([flight('SWA771')])
    render(<FlightsView entities={NO_ENTITIES} slide={1} onSelectSlide={() => {}} />)

    await waitFor(() => expect(document.querySelector('.track-stage')).toBeTruthy())
    expect(document.querySelector('.route-map')).toBeTruthy()
    expect(document.querySelector('.track-showcase')).toBeNull()
  })

  it('keeps the rotating aircraft showcase while nothing is tracked', async () => {
    mockTrack([])
    render(<FlightsView entities={NO_ENTITIES} slide={1} onSelectSlide={() => {}} />)

    await waitFor(() => expect(document.querySelector('.track-showcase')).toBeTruthy())
    expect(document.querySelector('.track-stage')).toBeNull()
    expect(screen.getByText(/No flight pinned/)).toBeTruthy()
  })

  it('falls back to the showcase when a tracked flight has no plottable route', async () => {
    // Route resolved by code only — one endpoint unknown, so there is nothing to draw a line between.
    mockTrack([flight('SWA771', { route: { fromCode: 'LAX', fromCity: 'Los Angeles', fromLat: 33.94, fromLon: -118.41, toCode: null, toCity: null, toLat: null, toLon: null } })])
    render(<FlightsView entities={NO_ENTITIES} slide={1} onSelectSlide={() => {}} />)

    await waitFor(() => expect(document.querySelectorAll('.track-card')).toHaveLength(1))
    expect(document.querySelector('.track-stage')).toBeNull()
    expect(document.querySelector('.track-showcase')).toBeTruthy()
  })
})
