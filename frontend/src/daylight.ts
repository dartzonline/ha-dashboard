/**
 * Where the sun is, and therefore which half of the world map is in daylight. Kept apart from the
 * component so the terminator geometry can be checked directly.
 */

/** Where the sun is overhead: 23.44° of tilt, swinging once a year. Cooper's approximation. */
export function solarDeclination(date: Date) {
  const dayOfYear = (date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86_400_000
  return -23.44 * Math.cos(((2 * Math.PI) / 365.24) * (dayOfYear + 10))
}

/**
 * The real day/night terminator as an SVG path in map coordinates, rather than a circle of shadow
 * pasted over one hemisphere. The sunlit half is a half of the *globe*, which on an
 * equirectangular map is a sine-like curve tilted by the season — in August the Arctic is in
 * daylight around the clock and Antarctica is in darkness, and a radial gradient cannot say that.
 *
 * Night is everywhere on the far side of the curve from the pole the sun is currently favouring,
 * so the path closes along whichever map edge that is.
 */
export function terminatorPath(date: Date) {
  const declination = solarDeclination(date)
  // Below about half a degree the terminator is a meridian and the latitude form blows up; the
  // clamp turns the equinox into a very steep curve instead, which draws the same thing.
  const tanDeclination = Math.tan((Math.sign(declination) * Math.max(Math.abs(declination), 0.6) * Math.PI) / 180)
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60
  const subsolarLon = (12 - utcHours) * 15

  const toX = (lon: number) => ((lon + 180) / 360) * 1000
  const toY = (lat: number) => ((90 - lat) / 180) * 500

  // Three world-widths, so the curve is already drawn across both wrapped edges of the map.
  const points: string[] = []
  for (let lon = -540; lon <= 540; lon += 3) {
    const hourAngle = ((lon - subsolarLon) * Math.PI) / 180
    const lat = (Math.atan(-Math.cos(hourAngle) / tanDeclination) * 180) / Math.PI
    points.push(`${points.length === 0 ? 'M' : 'L'}${toX(lon).toFixed(1)} ${toY(lat).toFixed(1)}`)
  }

  // The sun sits over the summer hemisphere, so night closes to the opposite edge of the map.
  const closingY = declination > 0 ? 500 : 0
  return `${points.join(' ')} L${toX(540).toFixed(1)} ${closingY} L${toX(-540).toFixed(1)} ${closingY} Z`
}
