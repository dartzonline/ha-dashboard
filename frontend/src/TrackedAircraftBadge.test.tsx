import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  const first = {
    query: 'SWA771',
    mode: 'track',
    flight: { callsign: 'SWA771', airline: 'Southwest', airlineCode: 'WN', type: 'B738', kind: 'jet' },
    route: { fromCode: 'BUR', fromCity: 'Burbank', toCode: 'AUS', toCity: 'Austin' },
    schedule: { arrScheduled: '2026-08-03 18:40', arrEstimated: '2026-08-03 18:40', delayMin: 0, status: 'en-route' },
    progress: 0.62,
    etaLine: 'in 41 min',
    ...overrides,
  }
  // The backend flattens the first pinned flight and repeats every one of them in `flights`.
  return { ...first, flights: [first] }
}

/** Two pinned flights: the first is also flattened at the top level, as the backend sends it. */
function twoPinned() {
  const first = trackPayload().flights[0]
  const second = {
    query: 'UAL455',
    mode: 'await',
    flight: null,
    route: { fromCode: 'DEN', fromCity: 'Denver', toCode: 'AUS', toCity: 'Austin' },
    schedule: { status: 'scheduled' },
    progress: 0,
    etaLine: null,
  }
  return { ...first, flights: [first, second] }
}

const EMPTY_SKY = { aircraft: [] }

function silhouette() {
  return document.querySelector('svg.flight-silhouette')
}

function dots() {
  return Array.from(document.querySelectorAll('.flight-dots i'))
}

function banner() {
  return document.querySelector('.flight-banner') as HTMLElement
}

/** A press-and-release across the banner, as a finger dragging it sideways would produce. */
function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  const target = banner()
  fireEvent.pointerDown(target, { clientX: from.x, clientY: from.y })
  fireEvent.pointerUp(target, { clientX: to.x, clientY: to.y })
  // The browser follows every release over the same element with a click; the banner has to tell
  // the two apart itself, so the test always sends both.
  fireEvent.click(target)
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

    await renderBadge({ query: null, mode: null, flight: null, route: null, flights: [] }, {
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
    await renderBadge({ query: null, mode: null, flight: null, route: null, flights: [] })
    await waitFor(() => expect(screen.getByText('Sky clear')).toBeTruthy())
    expect(document.querySelector('svg')!.querySelectorAll('path').length).toBeGreaterThan(0)
  })

  it('shows the airline logo inside the banner for a tracked flight', async () => {
    await renderBadge(trackPayload())
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())
    expect(document.querySelector('.flight-banner .flight-airline .flight-logo')).toBeTruthy()
  })

  it('renders no dots when there is only one thing to show', async () => {
    await renderBadge(trackPayload())
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())
    expect(dots()).toHaveLength(0)
  })

  it('rotates through every pinned flight', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', mockApi(twoPinned(), EMPTY_SKY))
    await act(async () => {
      render(<TrackedAircraftBadge entities={ENTITIES} />)
    })

    expect(screen.getByText('SWA771')).toBeTruthy()
    expect(screen.queryByText('UAL455')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(screen.getByText('UAL455')).toBeTruthy()

    // And back round again, so the rotation wraps rather than stopping at the end.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(screen.getByText('SWA771')).toBeTruthy()
  })

  it('marks the current position with one dot per reading', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', mockApi(twoPinned(), {
      aircraft: [{ callsign: 'AAL9', airlineCode: 'AA', type: 'B738', kind: 'jet', fromCode: 'DFW', toCode: 'AUS', distanceKm: 8 }],
    }))
    await act(async () => {
      render(<TrackedAircraftBadge entities={ENTITIES} />)
    })

    // Two pinned flights plus the nearest jet overhead.
    expect(dots()).toHaveLength(3)
    expect(dots().map((dot) => dot.className)).toEqual(['is-active', '', ''])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(dots().map((dot) => dot.className)).toEqual(['', 'is-active', ''])
  })
})

describe('TrackedAircraftBadge navigation', () => {
  /** Renders with a navigation callback and returns the calls made to it. */
  async function renderLinked(track: unknown, nearby: unknown = EMPTY_SKY) {
    const onOpenFlights = vi.fn()
    vi.stubGlobal('fetch', mockApi(track, nearby))
    await act(async () => {
      render(<TrackedAircraftBadge entities={ENTITIES} onOpenFlights={onOpenFlights} />)
    })
    return onOpenFlights
  }

  it('sends a tap on a pinned flight to the tracking page', async () => {
    const onOpenFlights = await renderLinked(trackPayload())
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())

    fireEvent.click(banner())
    expect(onOpenFlights).toHaveBeenCalledWith(1)
  })

  it('sends a tap on the jet overhead to the radar instead', async () => {
    // The two halves of the banner have different homes; landing both on the tracking page would
    // make half the taps look like they went to the wrong place.
    const onOpenFlights = await renderLinked({ query: null, mode: null, flight: null, route: null, flights: [] }, {
      aircraft: [{ callsign: 'AAL9', airlineCode: 'AA', type: 'B738', kind: 'jet', fromCode: 'DFW', toCode: 'AUS', distanceKm: 8 }],
    })
    await waitFor(() => expect(screen.getByText('AAL9')).toBeTruthy())

    fireEvent.click(banner())
    expect(onOpenFlights).toHaveBeenCalledWith(0)
  })

  it('sends a tap on an empty sky to the radar', async () => {
    const onOpenFlights = await renderLinked({ query: null, mode: null, flight: null, route: null, flights: [] })
    await waitFor(() => expect(screen.getByText('Sky clear')).toBeTruthy())

    fireEvent.click(banner())
    expect(onOpenFlights).toHaveBeenCalledWith(0)
  })

  it('steps to the next flight on a swipe without also navigating away from it', async () => {
    // The reported failure mode: the swipe brought UAL455 into view and the release's own click
    // immediately left the page, so the flight the user swiped to was never actually visible.
    const onOpenFlights = await renderLinked(twoPinned())
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())

    await act(async () => { drag({ x: 200, y: 40 }, { x: 120, y: 44 }) })

    expect(screen.getByText('UAL455')).toBeTruthy()
    expect(onOpenFlights).not.toHaveBeenCalled()
  })

  it('swipes back to the previous flight when dragged the other way', async () => {
    const onOpenFlights = await renderLinked(twoPinned())
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())

    await act(async () => { drag({ x: 120, y: 40 }, { x: 200, y: 44 }) })

    // Two readings, so stepping back from the first wraps round to the last.
    expect(screen.getByText('UAL455')).toBeTruthy()
    expect(onOpenFlights).not.toHaveBeenCalled()
  })

  it('treats a short drag as a tap and follows the banner', async () => {
    const onOpenFlights = await renderLinked(twoPinned())
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())

    await act(async () => { drag({ x: 200, y: 40 }, { x: 185, y: 42 }) })

    expect(onOpenFlights).toHaveBeenCalledWith(1)
    expect(screen.getByText('SWA771')).toBeTruthy()
  })

  it('treats a mostly-vertical drag as a tap rather than a swipe', async () => {
    // The wall panel's own vertical page gestures pass through the banner; reading them as flight
    // swipes would change the flight every time the user scrolled.
    const onOpenFlights = await renderLinked(twoPinned())
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())

    await act(async () => { drag({ x: 200, y: 40 }, { x: 140, y: 160 }) })

    expect(onOpenFlights).toHaveBeenCalledWith(1)
    expect(screen.getByText('SWA771')).toBeTruthy()
  })

  it('still follows a drag when there is only one flight to show', async () => {
    // With nothing to swipe between, a sideways drag has to stay a tap. Marking it as a swipe
    // anyway consumed the release's click, so the only banner on the board did nothing at all.
    const onOpenFlights = await renderLinked(trackPayload())
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())

    await act(async () => { drag({ x: 200, y: 40 }, { x: 100, y: 44 }) })

    expect(onOpenFlights).toHaveBeenCalledWith(1)
  })

  it('accepts a tap on the gesture after a swipe', async () => {
    // The swipe flag is cleared when the next gesture starts rather than when a click consumes it:
    // a swipe whose click never arrives would otherwise eat the following genuine tap.
    const onOpenFlights = await renderLinked(twoPinned())
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())

    await act(async () => { drag({ x: 200, y: 40 }, { x: 120, y: 44 }) })
    expect(onOpenFlights).not.toHaveBeenCalled()

    await act(async () => { drag({ x: 150, y: 40 }, { x: 150, y: 40 }) })
    expect(onOpenFlights).toHaveBeenCalledWith(1)
  })

  it('steps through flights on the arrow keys without leaving the page', async () => {
    const onOpenFlights = await renderLinked(twoPinned())
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())

    await act(async () => { fireEvent.keyDown(banner(), { key: 'ArrowRight' }) })
    expect(screen.getByText('UAL455')).toBeTruthy()
    expect(onOpenFlights).not.toHaveBeenCalled()

    await act(async () => { fireEvent.keyDown(banner(), { key: 'ArrowLeft' }) })
    expect(screen.getByText('SWA771')).toBeTruthy()
    expect(onOpenFlights).not.toHaveBeenCalled()
  })

  it('follows the banner on Enter', async () => {
    const onOpenFlights = await renderLinked(trackPayload())
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())

    await act(async () => { fireEvent.keyDown(banner(), { key: 'Enter' }) })
    expect(onOpenFlights).toHaveBeenCalledWith(1)
  })

  it('picks a flight from its dot without opening the Flights page', async () => {
    // Choosing which flight to look at is a different intent from navigating to it, so the dot's
    // click must not reach the banner underneath.
    const onOpenFlights = await renderLinked(twoPinned())
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())

    await act(async () => { fireEvent.click(dots()[1]) })

    expect(screen.getByText('UAL455')).toBeTruthy()
    expect(dots().map((dot) => dot.className)).toEqual(['', 'is-active'])
    expect(onOpenFlights).not.toHaveBeenCalled()
  })

  it('is inert when the header gave it nowhere to go', async () => {
    vi.stubGlobal('fetch', mockApi(trackPayload(), EMPTY_SKY))
    await act(async () => {
      render(<TrackedAircraftBadge entities={ENTITIES} />)
    })
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())

    expect(banner().getAttribute('role')).toBeNull()
    expect(banner().getAttribute('tabindex')).toBeNull()
    expect(banner().className).not.toContain('is-linked')
    // Nothing to assert but the absence of a crash: the click has no handler to reach.
    await act(async () => { fireEvent.click(banner()) })
    expect(screen.getByText('SWA771')).toBeTruthy()
  })

  it('announces itself as a button only once it has somewhere to go', async () => {
    await renderLinked(trackPayload())
    await waitFor(() => expect(screen.getByText('SWA771')).toBeTruthy())

    expect(banner().getAttribute('role')).toBe('button')
    expect(banner().getAttribute('tabindex')).toBe('0')
    expect(banner().className).toContain('is-linked')
  })
})
