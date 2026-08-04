import { useEffect, useMemo, useRef, useState } from 'react'
import { greatCircle, project, unwrap } from './routeGeometry'
import type { Point } from './routeGeometry'
import './RouteMap.css'

export interface RoutePoint {
  code: string | null
  city: string | null
  lat: number | null
  lon: number | null
}

export interface RouteMapProps {
  from: RoutePoint
  to: RoutePoint
  /** Live aircraft position, when the flight is actually reporting one. */
  position?: { lat: number; lon: number; trackDeg?: number | null } | null
  /** 0..1 along the route; the fallback for where to draw the aircraft with no live position. */
  progress?: number
  callsign?: string | null
  /** Small caption in the map's corner, e.g. "En route · 620 kt". */
  caption?: string | null
}

const TILE_SIZE = 256
const MIN_ZOOM = 1
const MAX_ZOOM = 9
/** Fraction of the viewport the route is allowed to occupy, leaving room for the end labels. */
const FIT_X = 0.74
const FIT_Y = 0.66

// Keyless CARTO raster tiles — the same basemap source the radar scope already draws on, so the
// two flight surfaces read as one map system. `dark_all` keeps place names, which is what makes a
// route across a continent legible at these zooms.
function tileUrl(zoom: number, x: number, y: number) {
  return `https://a.basemaps.cartocdn.com/dark_all/${zoom}/${x}/${y}.png`
}

function bearingBetween(from: Point, to: Point) {
  const toRad = (value: number) => (value * Math.PI) / 180
  const deltaLon = toRad(to.lon - from.lon)
  const y = Math.sin(deltaLon) * Math.cos(toRad(to.lat))
  const x = Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat))
    - Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(deltaLon)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/** The rendered size of the map, which the fit maths needs before it can pick a zoom. */
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const read = () => setSize({ width: node.clientWidth, height: node.clientHeight })
    read()
    // Absent under jsdom, and on any browser old enough to lack it the first read still stands.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return [ref, size] as const
}

function isPlaced(point: RoutePoint): point is RoutePoint & { lat: number; lon: number } {
  return typeof point.lat === 'number' && typeof point.lon === 'number'
}

/**
 * A tracked flight drawn where it actually is: the great-circle route on a real basemap, with the
 * origin and destination marked and the aircraft on the part of the line it has already flown.
 */
export function RouteMap({ from, to, position, progress = 0, callsign, caption }: RouteMapProps) {
  const [ref, size] = useElementSize<HTMLDivElement>()

  const geometry = useMemo(() => {
    if (!isPlaced(from) || !isPlaced(to) || size.width < 40 || size.height < 40) return null

    const arc = unwrap(greatCircle({ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }), from.lon)
    const plane = position ? unwrap([{ lat: position.lat, lon: position.lon }], arc[0].lon)[0] : null
    const world = plane ? [...arc, plane] : arc

    // Largest zoom at which the whole route still fits the viewport with room for its labels.
    let zoom = MIN_ZOOM
    for (let candidate = MAX_ZOOM; candidate >= MIN_ZOOM; candidate -= 1) {
      const projected = world.map((point) => project(point.lat, point.lon, candidate))
      const spanX = Math.max(...projected.map((p) => p.x)) - Math.min(...projected.map((p) => p.x))
      const spanY = Math.max(...projected.map((p) => p.y)) - Math.min(...projected.map((p) => p.y))
      if (spanX <= size.width * FIT_X && spanY <= size.height * FIT_Y) {
        zoom = candidate
        break
      }
    }

    const projected = world.map((point) => project(point.lat, point.lon, zoom))
    const centerX = (Math.max(...projected.map((p) => p.x)) + Math.min(...projected.map((p) => p.x))) / 2
    const centerY = (Math.max(...projected.map((p) => p.y)) + Math.min(...projected.map((p) => p.y))) / 2
    const originX = centerX - size.width / 2
    const originY = centerY - size.height / 2
    const toScreen = (point: Point) => {
      const p = project(point.lat, point.lon, zoom)
      return { x: p.x - originX, y: p.y - originY }
    }

    const worldTiles = 2 ** zoom
    const tiles: { key: string; url: string; left: number; top: number }[] = []
    for (let tx = Math.floor(originX / TILE_SIZE); tx <= Math.floor((originX + size.width) / TILE_SIZE); tx += 1) {
      for (let ty = Math.floor(originY / TILE_SIZE); ty <= Math.floor((originY + size.height) / TILE_SIZE); ty += 1) {
        // North and south of the map there is nothing to fetch, but east/west wraps around.
        if (ty < 0 || ty >= worldTiles) continue
        const wrappedX = ((tx % worldTiles) + worldTiles) % worldTiles
        tiles.push({
          key: `${tx}-${ty}`,
          url: tileUrl(zoom, wrappedX, ty),
          left: tx * TILE_SIZE - originX,
          top: ty * TILE_SIZE - originY,
        })
      }
    }

    // Where along the drawn arc the aircraft sits, so the flown and remaining halves split there
    // rather than at a fraction that ignores the live position.
    let splitIndex = Math.round(Math.max(0, Math.min(1, progress)) * (arc.length - 1))
    if (plane) {
      let best = Number.POSITIVE_INFINITY
      arc.forEach((point, index) => {
        const distance = (point.lat - plane.lat) ** 2 + (point.lon - plane.lon) ** 2
        if (distance < best) {
          best = distance
          splitIndex = index
        }
      })
    }

    const path = (points: Point[]) => points.map((point, index) => {
      const screen = toScreen(point)
      return `${index === 0 ? 'M' : 'L'}${screen.x.toFixed(1)} ${screen.y.toFixed(1)}`
    }).join(' ')

    // With no live position and no progress there is nothing to place: drawing the glyph on the
    // origin anyway would claim the aircraft is sitting there, which is not something we know.
    const marker = plane ?? (progress > 0 ? arc[splitIndex] : null)
    const heading = position?.trackDeg ?? bearingBetween(
      arc[Math.max(0, splitIndex - 1)],
      arc[Math.min(arc.length - 1, splitIndex + 1)],
    )

    return {
      tiles,
      flown: path([...arc.slice(0, splitIndex + 1), ...(plane ? [plane] : [])]),
      remaining: path([...(plane ? [plane] : []), ...arc.slice(splitIndex)]),
      start: toScreen(arc[0]),
      end: toScreen(arc[arc.length - 1]),
      aircraft: marker ? toScreen(marker) : null,
      heading,
      isLive: Boolean(plane),
    }
  }, [from, to, position, progress, size.width, size.height])

  const unplaced = !isPlaced(from) || !isPlaced(to)

  return (
    <div className="route-map" ref={ref}>
      {geometry && (
        <div className="route-map-tiles" aria-hidden="true">
          {geometry.tiles.map((tile) => (
            <img key={tile.key} src={tile.url} alt="" loading="eager" style={{ left: tile.left, top: tile.top }} />
          ))}
        </div>
      )}

      {geometry && size.width > 0 && (
        <svg
          className="route-map-overlay"
          viewBox={`0 0 ${size.width} ${size.height}`}
          role="img"
          aria-label={`Route from ${from.code ?? 'origin'} to ${to.code ?? 'destination'}${callsign ? ` for ${callsign}` : ''}`}
        >
          <path className="route-remaining" d={geometry.remaining} />
          <path className="route-flown" d={geometry.flown} />

          <g className="route-end route-end-origin" transform={`translate(${geometry.start.x} ${geometry.start.y})`}>
            <circle className="route-end-halo" r="11" />
            <circle className="route-end-dot" r="5" />
          </g>
          <g className="route-end route-end-destination" transform={`translate(${geometry.end.x} ${geometry.end.y})`}>
            <circle className="route-end-halo" r="11" />
            <circle className="route-end-dot" r="5" />
          </g>

          {geometry.aircraft && (
            <g className={`route-aircraft ${geometry.isLive ? 'is-live' : 'is-estimated'}`} transform={`translate(${geometry.aircraft.x} ${geometry.aircraft.y})`}>
              <circle className="route-aircraft-halo" r="13" />
              <path className="route-aircraft-glyph" transform={`rotate(${geometry.heading})`} d="M0,-9 L4.8,7 L0,4 L-4.8,7 Z" />
            </g>
          )}
        </svg>
      )}

      {geometry && (
        <>
          <div className="route-chip route-chip-origin" style={{ left: geometry.start.x, top: geometry.start.y }}>
            <strong>{from.code ?? '—'}</strong>
            {from.city && <small>{from.city}</small>}
          </div>
          <div className="route-chip route-chip-destination" style={{ left: geometry.end.x, top: geometry.end.y }}>
            <strong>{to.code ?? '—'}</strong>
            {to.city && <small>{to.city}</small>}
          </div>
        </>
      )}

      {unplaced && (
        <p className="route-map-empty">
          {from.code || to.code
            ? `Waiting on coordinates for ${from.code ?? '—'} → ${to.code ?? '—'}`
            : 'Route not resolved yet'}
        </p>
      )}

      {callsign && <span className="route-map-callsign">{callsign}</span>}
      {caption && <span className="route-map-caption">{caption}</span>}
      <span className="route-map-credit">© CARTO · OpenStreetMap</span>
    </div>
  )
}
