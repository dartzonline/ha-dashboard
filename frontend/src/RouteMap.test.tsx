import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RouteMap } from './RouteMap'
import { buildFlightLine, greatCircle, project, unwrap } from './routeGeometry'

/** jsdom performs no layout, so clientWidth/clientHeight read 0 and the map's fit maths bails out
    before drawing anything; standing in a size is what makes the geometry observable. */
function stubSize(width = 640, height = 360) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: width })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: height })
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
})

const LAX = { lat: 33.94, lon: -118.41 }
const NRT = { lat: 35.76, lon: 140.39 }
const AUS = { lat: 30.19, lon: -97.67 }

describe('project', () => {
  it('places the origin of the coordinate system at the centre of the world tile', () => {
    const point = project(0, 0, 0)
    expect(point.x).toBeCloseTo(128, 3)
    expect(point.y).toBeCloseTo(128, 3)
  })

  it('doubles pixel distances with each zoom level', () => {
    const near = project(30, -97, 4)
    const far = project(30, -97, 5)
    expect(far.x).toBeCloseTo(near.x * 2, 3)
    expect(far.y).toBeCloseTo(near.y * 2, 3)
  })

  it('clamps the poles instead of projecting them to infinity', () => {
    expect(Number.isFinite(project(90, 0, 3).y)).toBe(true)
    expect(Number.isFinite(project(-90, 0, 3).y)).toBe(true)
  })
})

describe('greatCircle', () => {
  it('starts and ends on the two airports it was given', () => {
    const arc = greatCircle(LAX, AUS, 8)
    expect(arc).toHaveLength(9)
    expect(arc[0].lat).toBeCloseTo(LAX.lat, 4)
    expect(arc[0].lon).toBeCloseTo(LAX.lon, 4)
    expect(arc[8].lat).toBeCloseTo(AUS.lat, 4)
    expect(arc[8].lon).toBeCloseTo(AUS.lon, 4)
  })

  it('arcs north on a transpacific route rather than running along the latitude', () => {
    // The whole reason for spherical interpolation: LAX-NRT really goes up past the Aleutians,
    // and a straight line on the map would draw it through the middle of the Pacific instead.
    const midpoint = greatCircle(LAX, NRT, 8)[4]
    expect(midpoint.lat).toBeGreaterThan(Math.max(LAX.lat, NRT.lat) + 8)
  })

  it('degrades to a two-point line when both ends are the same airport', () => {
    expect(greatCircle(AUS, { ...AUS }, 8)).toHaveLength(2)
  })
})

describe('unwrap', () => {
  it('keeps a path crossing the date line continuous instead of jumping the map', () => {
    const crossing = unwrap([{ lat: 50, lon: 179 }, { lat: 51, lon: -179 }], 179)
    expect(crossing[1].lon).toBeCloseTo(181, 6)
  })

  it('leaves an ordinary path untouched', () => {
    const path = [{ lat: 33, lon: -118 }, { lat: 31, lon: -100 }]
    expect(unwrap(path, -118)).toEqual(path)
  })
})

describe('buildFlightLine', () => {
  const midway = { lat: 32.0, lon: -108.0 }

  it('prefers real flown history over any kind of estimate', () => {
    const history = [LAX, midway]
    const line = buildFlightLine({ origin: LAX, destination: AUS, flownPoints: history, livePosition: midway, progress: 0.5 })
    expect(line.isLive).toBe(true)
    // The live position is appended so the drawn line reaches exactly where the aircraft is now.
    expect(line.flown).toEqual([...history, midway])
    expect(line.current).toEqual(midway)
  })

  it('draws an honest curve to a live position with no history yet, rather than a guess', () => {
    const line = buildFlightLine({ origin: LAX, destination: AUS, flownPoints: [], livePosition: midway })
    expect(line.isLive).toBe(true)
    expect(line.current).toEqual(midway)
    expect(line.flown[0].lat).toBeCloseTo(LAX.lat, 6)
    expect(line.flown[0].lon).toBeCloseTo(LAX.lon, 6)
    expect(line.flown[line.flown.length - 1].lat).toBeCloseTo(midway.lat, 6)
    expect(line.flown[line.flown.length - 1].lon).toBeCloseTo(midway.lon, 6)
  })

  it('falls back to a point along the plan only with neither history nor a live position', () => {
    const line = buildFlightLine({ origin: LAX, destination: AUS, progress: 0.5 })
    expect(line.isLive).toBe(false)
    expect(line.current).not.toBeNull()
    // Roughly halfway between the two airports -- not exact, since the plan is sampled, not continuous.
    expect(line.current!.lon).toBeGreaterThan(Math.min(LAX.lon, AUS.lon))
    expect(line.current!.lon).toBeLessThan(Math.max(LAX.lon, AUS.lon))
  })

  it('has nothing to place at all with no history, no live position and no progress', () => {
    const line = buildFlightLine({ origin: LAX, destination: AUS })
    expect(line.current).toBeNull()
    expect(line.flown).toEqual([])
    expect(line.isLive).toBe(false)
  })

  it('the plan is always the full origin-to-destination great circle regardless of what was flown', () => {
    const line = buildFlightLine({ origin: LAX, destination: AUS, livePosition: midway })
    expect(line.plan[0].lat).toBeCloseTo(LAX.lat, 6)
    expect(line.plan[0].lon).toBeCloseTo(LAX.lon, 6)
    expect(line.plan[line.plan.length - 1].lat).toBeCloseTo(AUS.lat, 6)
    expect(line.plan[line.plan.length - 1].lon).toBeCloseTo(AUS.lon, 6)
  })

  it('remaining is a fresh great circle from the current position, not a leftover slice of the plan', () => {
    // A position well off the LAX-AUS great circle -- the old slice-based approach would have
    // "remaining" resume from whatever point on the *original* arc happened to be nearest, not
    // from here. A fresh great circle from the real current position always starts exactly there.
    const offCourse = { lat: 34.5, lon: -112.0 }
    const line = buildFlightLine({ origin: LAX, destination: AUS, livePosition: offCourse })
    expect(line.remaining[0].lat).toBeCloseTo(offCourse.lat, 6)
    expect(line.remaining[0].lon).toBeCloseTo(offCourse.lon, 6)
    expect(line.remaining[line.remaining.length - 1].lat).toBeCloseTo(AUS.lat, 6)
    expect(line.remaining[line.remaining.length - 1].lon).toBeCloseTo(AUS.lon, 6)
  })

  it('remaining is the whole plan when nothing about the current position is known', () => {
    const line = buildFlightLine({ origin: LAX, destination: AUS })
    expect(line.remaining).toEqual(line.plan)
  })
})

describe('RouteMap', () => {
  it('says what it is waiting for when only one end has resolved', () => {
    render(
      <RouteMap
        from={{ code: 'AUS', city: 'Austin', lat: 30.19, lon: -97.67 }}
        to={{ code: 'LHR', city: 'London', lat: null, lon: null }}
      />,
    )
    expect(screen.getByText(/Waiting on coordinates for AUS → LHR/)).toBeTruthy()
  })

  it('still identifies the flight when the route has not resolved at all', () => {
    render(
      <RouteMap
        from={{ code: null, city: null, lat: null, lon: null }}
        to={{ code: null, city: null, lat: null, lon: null }}
        callsign="SWA771"
      />,
    )
    expect(screen.getByText('Route not resolved yet')).toBeTruthy()
    expect(screen.getByText('SWA771')).toBeTruthy()
  })

  const AUSTIN = { code: 'AUS', city: 'Austin', lat: 30.19, lon: -97.67 }
  const LOS_ANGELES = { code: 'LAX', city: 'Los Angeles', lat: 33.94, lon: -118.41 }

  it('draws the great circle plan and a separate flown-history line', () => {
    stubSize()
    render(
      <RouteMap
        from={LOS_ANGELES}
        to={AUSTIN}
        flownPath={[{ lat: 33.94, lon: -118.41 }, { lat: 32.0, lon: -108.0 }]}
      />,
    )
    const plan = document.querySelector('path.route-plan')
    const flown = document.querySelector('path.route-flown')
    expect(plan?.getAttribute('d')).toBeTruthy()
    expect(flown?.getAttribute('d')).toBeTruthy()
    // Two genuinely different lines, not the same path duplicated under two class names.
    expect(plan?.getAttribute('d')).not.toBe(flown?.getAttribute('d'))
  })

  it('marks the aircraft live when placed from real flown history, with no live position given', () => {
    stubSize()
    render(
      <RouteMap
        from={LOS_ANGELES}
        to={AUSTIN}
        flownPath={[{ lat: 33.94, lon: -118.41 }, { lat: 32.0, lon: -108.0 }]}
      />,
    )
    expect(document.querySelector('.route-aircraft.is-live')).toBeTruthy()
    expect(document.querySelector('.route-aircraft.is-estimated')).toBeNull()
  })

  it('marks the aircraft estimated when it is placed from progress alone', () => {
    stubSize()
    render(<RouteMap from={LOS_ANGELES} to={AUSTIN} progress={0.5} />)
    expect(document.querySelector('.route-aircraft.is-estimated')).toBeTruthy()
    expect(document.querySelector('.route-aircraft.is-live')).toBeNull()
  })

  it('draws no aircraft at all with no history, no live position and no progress', () => {
    stubSize()
    render(<RouteMap from={LOS_ANGELES} to={AUSTIN} />)
    expect(document.querySelector('.route-aircraft')).toBeNull()
  })
})
