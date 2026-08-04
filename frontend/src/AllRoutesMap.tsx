import { useEffect, useMemo, useRef, useState } from 'react'
import { greatCircle, project, unwrap } from './routeGeometry'
import type { Point } from './routeGeometry'
import './AllRoutesMap.css'

export interface MapRoute {
  key: string
  callsign: string
  from: { code: string | null; lat: number | null; lon: number | null }
  to: { code: string | null; lat: number | null; lon: number | null }
  position?: { lat: number; lon: number; trackDeg?: number | null } | null
  progress?: number
  isLanded?: boolean
}

const TILE_SIZE = 256
const MIN_ZOOM = 1
const MAX_ZOOM = 9
/** Leaves room for the end chips and the flight-number labels, which sit outside the arcs. */
const FIT_X = 0.8
const FIT_Y = 0.7
/** Fewer samples than the single-route map: several arcs are drawn at once and none is the subject. */
const ARC_SAMPLES = 48

function tileUrl(zoom: number, x: number, y: number) {
  return `https://a.basemaps.cartocdn.com/dark_all/${zoom}/${x}/${y}.png`
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const read = () => setSize({ width: node.clientWidth, height: node.clientHeight })
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return [ref, size] as const
}

function isPlaced(point: { lat: number | null; lon: number | null }): point is { lat: number; lon: number } {
  return typeof point.lat === 'number' && typeof point.lon === 'number'
}

/**
 * Shifts an already-unwrapped arc by whole turns so it sits nearest `reference`.
 *
 * Each arc is unwrapped against its own origin to stay continuous across the date line, which can
 * leave two arcs a full turn apart in projected space — a Singapore route and a Barcelona route
 * would then be drawn on opposite sides of a world that has to hold both. Re-seating each arc
 * against one shared reference puts them all in the same copy of the world.
 */
function align(points: Point[], reference: number): Point[] {
  const turns = Math.round((reference - points[0].lon) / 360)
  return turns === 0 ? points : points.map((point) => ({ lat: point.lat, lon: point.lon + turns * 360 }))
}

/**
 * Every tracked flight on one basemap, each route labelled with its flight number.
 *
 * The per-flight map answers "where is this one"; this answers "where is everything I am waiting
 * on" without rotating through them, which is the only way to see two flights converge on the
 * same airport.
 */
export function AllRoutesMap({ routes }: { routes: MapRoute[] }) {
  const [ref, size] = useElementSize<HTMLDivElement>()

  const drawable = useMemo(
    () => routes.filter((route) => isPlaced(route.from) && isPlaced(route.to)),
    [routes],
  )

  const geometry = useMemo(() => {
    if (drawable.length === 0 || size.width < 40 || size.height < 40) return null

    const reference = drawable[0].from.lon as number
    const arcs = drawable.map((route) => {
      const raw = greatCircle(
        { lat: route.from.lat as number, lon: route.from.lon as number },
        { lat: route.to.lat as number, lon: route.to.lon as number },
        ARC_SAMPLES,
      )
      const arc = align(unwrap(raw, route.from.lon as number), reference)
      const plane = route.position
        ? align(unwrap([{ lat: route.position.lat, lon: route.position.lon }], arc[0].lon), reference)[0]
        : null
      return { route, arc, plane }
    })

    const world = arcs.flatMap(({ arc, plane }) => (plane ? [...arc, plane] : arc))

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

    const lines = arcs.map(({ route, arc, plane }, order) => {
      let splitIndex = Math.round(Math.max(0, Math.min(1, route.progress ?? 0)) * (arc.length - 1))
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

      const marker = plane ?? ((route.progress ?? 0) > 0 ? arc[splitIndex] : null)
      // The label rides the aircraft when there is one, so the number sits on the part of the path
      // that is actually moving; the arc's midpoint is the fallback for a flight not yet flying.
      const anchor = marker ?? arc[Math.floor(arc.length / 2)]

      return {
        key: route.key,
        callsign: route.callsign,
        order,
        isLanded: Boolean(route.isLanded),
        flown: path([...arc.slice(0, splitIndex + 1), ...(plane ? [plane] : [])]),
        remaining: path([...(plane ? [plane] : []), ...arc.slice(splitIndex)]),
        start: toScreen(arc[0]),
        end: toScreen(arc[arc.length - 1]),
        fromCode: route.from.code,
        toCode: route.to.code,
        aircraft: marker ? toScreen(marker) : null,
        label: toScreen(anchor),
        isLive: Boolean(plane),
      }
    })

    return { tiles, lines }
  }, [drawable, size.width, size.height])

  if (drawable.length === 0) {
    return (
      <div className="all-routes-map is-empty" ref={ref}>
        <p className="all-routes-empty">
          {routes.length > 0 ? 'Waiting on coordinates for the tracked flights' : 'No flights tracked yet'}
        </p>
      </div>
    )
  }

  return (
    <div className="all-routes-map" ref={ref}>
      {geometry && (
        <div className="all-routes-tiles" aria-hidden="true">
          {geometry.tiles.map((tile) => (
            <img key={tile.key} src={tile.url} alt="" loading="eager" style={{ left: tile.left, top: tile.top }} />
          ))}
        </div>
      )}

      {geometry && size.width > 0 && (
        <svg
          className="all-routes-overlay"
          viewBox={`0 0 ${size.width} ${size.height}`}
          role="img"
          aria-label={`All tracked flights: ${geometry.lines.map((line) => `${line.callsign} ${line.fromCode ?? '?'} to ${line.toCode ?? '?'}`).join('; ')}`}
        >
          {geometry.lines.map((line) => (
            <g key={line.key} className={`all-route tone-${line.order % 6} ${line.isLanded ? 'is-landed' : ''}`.trim()}>
              <path className="all-route-remaining" d={line.remaining} />
              <path className="all-route-flown" d={line.flown} />
              <circle className="all-route-end" cx={line.start.x} cy={line.start.y} r="4" />
              <circle className="all-route-end" cx={line.end.x} cy={line.end.y} r="4" />
              {line.aircraft && (
                <g className={`all-route-aircraft ${line.isLive ? 'is-live' : 'is-estimated'}`} transform={`translate(${line.aircraft.x} ${line.aircraft.y})`}>
                  <path className="all-route-glyph" d="M0,-7 L3.8,5.5 L0,3 L-3.8,5.5 Z" />
                </g>
              )}
            </g>
          ))}
        </svg>
      )}

      {geometry && geometry.lines.map((line) => (
        <span
          key={line.key}
          className={`all-route-label tone-${line.order % 6} ${line.isLanded ? 'is-landed' : ''}`.trim()}
          style={{ left: line.label.x, top: line.label.y }}
        >
          <strong>{line.callsign}</strong>
          <small>{line.fromCode ?? '—'}→{line.toCode ?? '—'}</small>
        </span>
      ))}

      <span className="all-routes-credit">© CARTO · OpenStreetMap</span>
    </div>
  )
}
