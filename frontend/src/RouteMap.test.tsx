import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RouteMap } from './RouteMap'
import { greatCircle, project, unwrap } from './routeGeometry'

afterEach(cleanup)

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
})
