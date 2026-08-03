import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrackedAircraftBadge } from './TrackedAircraftBadge'
import { AIRCRAFT_ART, arrivalVerdict, artKeyForAircraft } from './flightBadge'
import type { HAEntity } from './types'

const ENTITIES = new Map<string, HAEntity>([
  [
    'zone.home',
    { entity_id: 'zone.home', state: 'zoning', attributes: { latitude: 30.63, longitude: -97.68 } } as unknown as HAEntity,
  ],
])

/** Serves the two endpoints the badge polls; anything else is a test bug, not a runtime one. */
function mockApi(track: unknown, nearby: unknown) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.includes('flights/track') ? track : url.includes('flights/nearby') ? nearby : null
    if (body === null) throw new Error(`Unexpected fetch: ${url}`)
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  })
}

function trackPayload(overrides: Record<string, unknown> = {}) {
  return {
    query: 'SWA771',
    mode: 'track',
    flight: { callsign: 'SWA771', airline: 'Southwest', airlineCode: 'WN', type: 'B738', kind: 'jet' },
    route: { fromCode: 'BUR', fromCity: 'Burbank', toCode: 'AUS', toCity: 'Austin' },
    schedule: { arrScheduled: '2026-08-03 18:40', arrEstimated: '2026-08-03 18:40', delayMin: 0, status: 'en-route' },
    progress: 0.62,
    etaLine: 'in 41 min',
    ...overrides,
  }
}

const EMPTY_SKY = { aircraft: [] }

function silhouette() {
  return document.querySelector('svg.flight-silhouette')
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('AIRCRAFT_ART', () => {
  // a350.svg once shipped as a saved 404 page, which a CSS mask rendered as a silent blank box.
  it.each(Object.entries(AIRCRAFT_ART))('%s is real drawable geometry', (_key, art) => {
    expect(art).toMatch(/<path\b/)
    expect(art).not.toMatch(/<html|404 Not Found/i)
    expect(art.replace(/\s/g, '').length).toBeGreaterThan(500)
  })

  it('leaves no hard-coded black that would ignore the banner tone', () => {
    for (const art of Object.values(AIRCRAFT_ART)) expect(art).not.toContain('#000000')
  })
})

describe('artKeyForAircraft', () => {
  it.each([
    ['B738', 'b737'],
    ['737NG 800/W', 'b737'],
    ['A321', 'b737'],
    ['A320-232', 'b737'],
    ['B77W', 'b777'],
    ['Boeing 777-300ER', 'b777'],
    ['B789', 'b787'],
    ['B763', 'b767'],
    ['B744', 'b747'],
    ['A388', 'a380'],
    ['A343', 'a340'],
    ['A333', 'a330'],
    ['A359', 'a330'],
    ['CRJ9', 'crjx'],
    ['E175', 'crjx'],
    ['MD11', 'md11'],
  ])('maps %s to the %s silhouette', (type, expected) => {
    expect(artKeyForAircraft(type)).toBe(expected)
  })

  it('falls back to a narrowbody when the type is unknown', () => {
    expect(artKeyForAircraft(null)).toBe('a320')
    expect(artKeyForAircraft('')).toBe('a320')
  })
})

describe('arrivalVerdict', () => {
  it('reads on time when the flight is not late', () => {
    expect(arrivalVerdict({ delayMin: 0 })).toEqual({ tone: 'good', label: 'On time' })
    expect(arrivalVerdict({ delayMin: -4 })).toEqual({ tone: 'good', label: 'On time' })
  })

  it('warns on a small slip and goes red on a real delay', () => {
    expect(arrivalVerdict({ delayMin: 9 })).toEqual({ tone: 'warn', label: '9 min late' })
    expect(arrivalVerdict({ delayMin: 47 })).toEqual({ tone: 'danger', label: '47 min late' })
  })

  it('stays neutral when the schedule source has said nothing', () => {
    expect(arrivalVerdict({})).toBeNull()
    expect(arrivalVerdict({ status: 'scheduled' })).toEqual({ tone: 'muted', label: 'Scheduled' })
  })
})

describe('TrackedAircraftBadge', () => {
  async function renderBadge(track: unknown, nearby: unknown = EMPTY_SKY) {
    vi.stubGlobal('fetch', mockApi(track, nearby))
    await act(async () => {
      render(<TrackedAircraftBadge entities={ENTITIES} />)
    })
  }

  it('draws real aircraft artwork, not an empty box', async () => {
    await renderBadge(trackPayload())
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())

    const svg = silhouette()
    expect(svg).toBeTruthy()
    // A mask that fails to load leaves a coloured rectangle; real geometry is the proof it rendered.
    const paths = svg!.querySelectorAll('path')
    expect(paths.length).toBeGreaterThan(0)
    expect(paths[0].getAttribute('d')!.length).toBeGreaterThan(200)
    expect(svg!.getAttribute('fill')).toBe('currentColor')
    expect(svg!.innerHTML).not.toContain('#000000')
  })

  it('uses the same artwork path for a tracked flight as for an overhead one', async () => {
    await renderBadge(trackPayload())
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())
    const tracked = silhouette()!.innerHTML
    cleanup()

    await renderBadge({ query: null, mode: null, flight: null, route: null }, {
      aircraft: [{ callsign: 'SWA771', airlineCode: 'WN', type: 'B738', kind: 'jet', fromCode: 'BUR', toCode: 'AUS', distanceKm: 15 }],
    })
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())

    expect(silhouette()!.innerHTML).toBe(tracked)
  })

  it('picks the silhouette from the tracked aircraft type', async () => {
    await renderBadge(trackPayload({ flight: { callsign: 'UAL1', airlineCode: 'UA', type: 'B77W', kind: 'jet' } }))
    await waitFor(() => expect(screen.getByText('UAL1')).toBeTruthy())

    const widebody = silhouette()!.innerHTML
    cleanup()

    await renderBadge(trackPayload())
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())

    expect(silhouette()!.innerHTML).not.toBe(widebody)
  })

  it('says a tracked flight is on time in green', async () => {
    await renderBadge(trackPayload())
    await waitFor(() => expect(screen.getByText('Arrives 18:40')).toBeTruthy())
    expect(screen.getByText('On time').className).toContain('tone-good')
  })

  it('says a tracked flight is late in red', async () => {
    await renderBadge(trackPayload({ schedule: { arrEstimated: '2026-08-03 19:25', delayMin: 45, status: 'en-route' } }))
    await waitFor(() => expect(screen.getByText('45 min late')).toBeTruthy())
    expect(screen.getByText('45 min late').className).toContain('tone-danger')
  })

  it('falls back to the live time-to-run when no schedule clock exists', async () => {
    await renderBadge(trackPayload({ schedule: { delayMin: 0 } }))
    await waitFor(() => expect(screen.getByText('in 41 min')).toBeTruthy())
  })

  it('still draws an aircraft when the sky is empty', async () => {
    await renderBadge({ query: null, mode: null, flight: null, route: null })
    await waitFor(() => expect(screen.getByText('Sky clear')).toBeTruthy())
    expect(document.querySelector('svg')!.querySelectorAll('path').length).toBeGreaterThan(0)
  })
})
