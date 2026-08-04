import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AllRoutesMap } from './AllRoutesMap'
import type { MapRoute } from './AllRoutesMap'
import { greatCircle, unwrap } from './routeGeometry'

const WIDTH = 640
const HEIGHT = 360

/**
 * jsdom performs no layout, so `clientWidth`/`clientHeight` both read 0 and the map's fit maths
 * bails out before drawing anything. Standing in a size is what makes the geometry observable.
 */
function stubSize(width = WIDTH, height = HEIGHT) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: width })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: height })
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
})

const LAX = { code: 'LAX', lat: 33.94, lon: -118.41 }
const AUS = { code: 'AUS', lat: 30.19, lon: -97.67 }
const DFW = { code: 'DFW', lat: 32.9, lon: -97.04 }
const SIN = { code: 'SIN', lat: 1.36, lon: 103.99 }
const SFO = { code: 'SFO', lat: 37.62, lon: -122.38 }
const BCN = { code: 'BCN', lat: 41.3, lon: 2.08 }
const NOWHERE = { code: 'LHR', lat: null, lon: null }

function route(callsign: string, from: MapRoute['from'], to: MapRoute['to'], overrides: Partial<MapRoute> = {}): MapRoute {
  return { key: callsign, callsign, from, to, ...overrides }
}

function groups() {
  return Array.from(document.querySelectorAll('g.all-route'))
}

/** Where each flight number ended up on screen, keyed by callsign. */
function labelPositions() {
  return new Map(Array.from(document.querySelectorAll('.all-route-label')).map((node) => {
    const element = node as HTMLElement
    return [element.querySelector('strong')!.textContent!, {
      x: Number.parseFloat(element.style.left),
      y: Number.parseFloat(element.style.top),
    }]
  }))
}

describe('AllRoutesMap', () => {
  it('says nothing is pinned when it was given no routes at all', () => {
    stubSize()
    render(<AllRoutesMap routes={[]} />)
    expect(screen.getByText('No flights tracked yet')).toBeTruthy()
  })

  it('distinguishes a pinned flight it cannot place from having nothing pinned', () => {
    // Two different problems: one means the user pinned nothing, the other means the route lookup
    // has not resolved yet. Showing "nothing tracked" for the second would look like a lost pin.
    stubSize()
    render(<AllRoutesMap routes={[route('BAW9', NOWHERE, NOWHERE)]} />)
    expect(screen.getByText('Waiting on coordinates for the tracked flights')).toBeTruthy()
    expect(screen.queryByText('No flights tracked yet')).toBeNull()
  })

  it('skips the route it cannot place and still draws the ones it can', () => {
    stubSize()
    render(<AllRoutesMap routes={[route('SWA771', LAX, AUS), route('BAW9', LAX, NOWHERE)]} />)

    expect(groups()).toHaveLength(1)
    expect(screen.getByText('SWA771')).toBeTruthy()
    expect(screen.queryByText('BAW9')).toBeNull()
  })

  it('labels every drawable route with its flight number and its end codes', () => {
    stubSize()
    render(<AllRoutesMap routes={[route('SWA771', LAX, AUS), route('AAL69', BCN, DFW)]} />)

    expect(screen.getByText('SWA771')).toBeTruthy()
    expect(screen.getByText('LAX→AUS')).toBeTruthy()
    expect(screen.getByText('AAL69')).toBeTruthy()
    expect(screen.getByText('BCN→DFW')).toBeTruthy()
  })

  it('gives each route its own hue, cycling once six are in the air', () => {
    stubSize()
    const routes = Array.from({ length: 7 }, (_, index) => route(`FL${index}`, LAX, AUS))
    render(<AllRoutesMap routes={routes} />)

    const tones = groups().map((group) => Array.from(group.classList).find((name) => name.startsWith('tone-')))
    expect(tones).toEqual(['tone-0', 'tone-1', 'tone-2', 'tone-3', 'tone-4', 'tone-5', 'tone-0'])
    // The label carries the same tone, so the number and the line it belongs to read as one thing.
    expect(document.querySelectorAll('.all-route-label.tone-1')).toHaveLength(1)
  })

  it('greys a landed flight rather than dropping it off the map', () => {
    stubSize()
    render(<AllRoutesMap routes={[route('SWA771', LAX, AUS, { progress: 1, isLanded: true }), route('AAL69', BCN, DFW)]} />)

    expect(groups()).toHaveLength(2)
    expect(groups()[0].classList.contains('is-landed')).toBe(true)
    expect(groups()[1].classList.contains('is-landed')).toBe(false)
    expect(document.querySelector('.all-route-label.is-landed strong')!.textContent).toBe('SWA771')
  })

  it('marks an aircraft drawn from a live position as live', () => {
    stubSize()
    render(<AllRoutesMap routes={[route('SWA771', LAX, AUS, { position: { lat: 32.5, lon: -108 }, progress: 0.5 })]} />)

    expect(document.querySelector('.all-route-aircraft.is-live')).toBeTruthy()
    expect(document.querySelector('.all-route-aircraft.is-estimated')).toBeNull()
  })

  it('marks an aircraft placed from progress alone as estimated', () => {
    stubSize()
    render(<AllRoutesMap routes={[route('SWA771', LAX, AUS, { progress: 0.5 })]} />)

    expect(document.querySelector('.all-route-aircraft.is-estimated')).toBeTruthy()
    expect(document.querySelector('.all-route-aircraft.is-live')).toBeNull()
  })

  it('draws no aircraft at all for a flight that has not started', () => {
    // With no position and no progress the glyph would have to sit on the origin, which would claim
    // the aircraft is on the ground there — something we do not actually know.
    stubSize()
    render(<AllRoutesMap routes={[route('SWA771', LAX, AUS, { progress: 0 })]} />)

    expect(groups()).toHaveLength(1)
    expect(document.querySelector('.all-route-aircraft')).toBeNull()
  })

  it('draws a date-line route and a European route on the same screen', () => {
    // SIN→SFO is unwrapped east past the date line and ends up around lon 238, while BCN→DFW stays
    // in the −97..2 range. Both have to land inside one viewport rather than one being flung into a
    // neighbouring copy of the world.
    stubSize()
    render(
      <AllRoutesMap
        routes={[
          route('SQ34', SIN, SFO, { position: { lat: 45, lon: -170 }, progress: 0.6 }),
          route('AAL69', BCN, DFW, { position: { lat: 45, lon: -40 }, progress: 0.5 }),
        ]}
      />,
    )

    const labels = labelPositions()
    expect(labels.size).toBe(2)
    for (const [callsign, at] of labels) {
      expect(Number.isFinite(at.x), `${callsign} x`).toBe(true)
      expect(at.x, `${callsign} x`).toBeGreaterThanOrEqual(0)
      expect(at.x, `${callsign} x`).toBeLessThanOrEqual(WIDTH)
      expect(at.y, `${callsign} y`).toBeGreaterThanOrEqual(0)
      expect(at.y, `${callsign} y`).toBeLessThanOrEqual(HEIGHT)
    }
    // And they are genuinely two separate routes on that screen, not stacked on one point.
    expect(Math.abs(labels.get('SQ34')!.x - labels.get('AAL69')!.x)).toBeGreaterThan(20)
  })

  it('re-seats an arc that its own unwrap left a full turn away from the others', () => {
    // This is the case `align` exists for: SFO is more than 180° from the SIN reference, so the
    // SFO→BCN arc unwraps around lon −122 while the SIN→SFO arc sits above 100. Left alone the two
    // are a whole 360° apart in projected space and one is drawn off the edge of the world.
    const reference = SIN.lon
    const strayOrigin = unwrap(greatCircle(SFO, BCN, 48), SFO.lon)[0].lon
    expect(Math.round((reference - strayOrigin) / 360)).not.toBe(0)

    stubSize()
    render(
      <AllRoutesMap
        routes={[
          route('SQ34', SIN, SFO, { position: { lat: 45, lon: -170 }, progress: 0.6 }),
          route('UAL85', SFO, BCN, { position: { lat: 50, lon: -60 }, progress: 0.5 }),
        ]}
      />,
    )

    const labels = labelPositions()
    expect(labels.size).toBe(2)
    for (const [callsign, at] of labels) {
      expect(at.x, `${callsign} x`).toBeGreaterThanOrEqual(0)
      expect(at.x, `${callsign} x`).toBeLessThanOrEqual(WIDTH)
      expect(at.y, `${callsign} y`).toBeGreaterThanOrEqual(0)
      expect(at.y, `${callsign} y`).toBeLessThanOrEqual(HEIGHT)
    }

    // Both routes touch SFO, so the arrival dot of the first and the departure dot of the second
    // are the same airport and must land on the same pixel. An unaligned arc puts them a whole
    // world apart, which is the visible symptom: one route drawn off the side of the map.
    const [inbound, outbound] = groups().map((group) => Array.from(group.querySelectorAll('circle.all-route-end')))
    const arrival = Number(inbound[1].getAttribute('cx'))
    const departure = Number(outbound[0].getAttribute('cx'))
    expect(departure).toBeCloseTo(arrival, 1)
  })
})
