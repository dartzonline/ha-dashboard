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

