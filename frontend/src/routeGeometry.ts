/**
 * Map geometry for the flight route map: Web Mercator projection, great-circle interpolation and
 * date-line unwrapping. Separate from the component so the maths can be tested on its own.
 */
const TILE_SIZE = 256
/** Samples along the great circle: enough that a long-haul arc reads as a curve, not a chain. */
export const ARC_SAMPLES = 96

export interface Point {
  lat: number
  lon: number
}

/** Web Mercator, in pixels at the given zoom. Longitude is *not* wrapped: callers unwrap first. */
export function project(lat: number, lon: number, zoom: number) {
  const worldSize = TILE_SIZE * 2 ** zoom
  const clamped = Math.max(-85.05, Math.min(85.05, lat))
  const rad = (clamped * Math.PI) / 180
  return {
    x: ((lon + 180) / 360) * worldSize,
    y: ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * worldSize,
  }
}

/**
 * The shortest path between two airports is a great circle, which on a Mercator map is a curve —
 * drawing a straight line instead would put a Chicago–Tokyo flight over the wrong ocean. Sampled by
 * spherical interpolation so the rendered arc matches the route the aircraft is actually flying.
 */
export function greatCircle(from: Point, to: Point, samples = ARC_SAMPLES): Point[] {
  const toRad = (value: number) => (value * Math.PI) / 180
  const toDeg = (value: number) => (value * 180) / Math.PI
  const [lat1, lon1, lat2, lon2] = [toRad(from.lat), toRad(from.lon), toRad(to.lat), toRad(to.lon)]

  const delta = 2 * Math.asin(Math.sqrt(
    Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
  ))
  // Coincident endpoints have no defined arc; a two-point line is the honest degenerate case.
  if (!Number.isFinite(delta) || delta < 1e-9) return [from, to]

  return Array.from({ length: samples + 1 }, (_, index) => {
    const fraction = index / samples
    const a = Math.sin((1 - fraction) * delta) / Math.sin(delta)
    const b = Math.sin(fraction * delta) / Math.sin(delta)
    const x = a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2)
    const y = a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2)
    const z = a * Math.sin(lat1) + b * Math.sin(lat2)
    return { lat: toDeg(Math.atan2(z, Math.hypot(x, y))), lon: toDeg(Math.atan2(y, x)) }
  })
}

/**
 * Mercator has a seam at ±180°, and a trans-Pacific route crosses it. Rewriting each longitude to
 * whichever equivalent value sits nearest the previous one keeps the drawn line continuous; the
 * tile layer wraps the resulting off-world coordinates back into range when it fetches.
 */
export function unwrap(points: Point[], reference: number): Point[] {
  let previous = reference
  return points.map((point) => {
    let lon = point.lon
    while (lon - previous > 180) lon -= 360
    while (previous - lon > 180) lon += 360
    previous = lon
    return { lat: point.lat, lon }
  })
}

export interface FlightLineInput {
  origin: Point
  destination: Point
  /** Real historical positions since departure, earliest first. Empty/absent when unavailable. */
  flownPoints?: Point[] | null
  /** The aircraft's live reported position, when it has one. */
  livePosition?: Point | null
  /** 0..1 fallback for where to place the aircraft with no history and no live position at all. */
  progress?: number
  samples?: number
}

export interface FlightLine {
  /** The idealised origin -> destination great circle, unaffected by any deviation flown. */
  plan: Point[]
  /** Where the aircraft has actually been, ending at its current (or best-known) position. */
  flown: Point[]
  /** A fresh great circle from the current position onward -- the plan *from here*, which is not
      the same line as the back half of `plan` once the flight has deviated from it at all. */
  remaining: Point[]
  /** The aircraft's drawn position, or null when nothing is known yet. */
  current: Point | null
  /** True when `current` is a real reported position rather than a `progress`-based estimate. */
  isLive: boolean
}

/**
 * Chooses what to draw for one flight's progress along its route, in plain lat/lon -- callers
 * project and unwrap the pieces afterward, same as they already do for a plain great circle.
 *
 * Real flown history is preferred whenever there is any, because it is what actually happened:
 * ATC vectoring, weather deviation and holding patterns all show up in it and none of them show up
 * in a straight interpolation. A live position with no history yet still gets an honest curve to
 * wherever it actually is, rather than a point borrowed from the unrelated origin-destination arc.
 * Only with neither is a `progress` fraction along the idealised plan used, and only as a last
 * resort -- it is the one case here that is a guess rather than a fact.
 */
export function buildFlightLine({
  origin, destination, flownPoints, livePosition, progress = 0, samples,
}: FlightLineInput): FlightLine {
  const plan = greatCircle(origin, destination, samples)

  let flown: Point[]
  let current: Point | null
  let isLive: boolean

  if (flownPoints && flownPoints.length > 0) {
    flown = livePosition ? [...flownPoints, livePosition] : flownPoints.slice()
    current = flown[flown.length - 1]
    isLive = true
  } else if (livePosition) {
    flown = greatCircle(origin, livePosition, samples)
    current = livePosition
    isLive = true
  } else if (progress > 0) {
    const index = Math.round(Math.min(1, Math.max(0, progress)) * (plan.length - 1))
    flown = plan.slice(0, index + 1)
    current = plan[index]
    isLive = false
  } else {
    flown = []
    current = null
    isLive = false
  }

  const remaining = current ? greatCircle(current, destination, samples) : plan
  return { plan, flown, remaining, current, isLive }
}

