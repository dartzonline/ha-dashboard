import { Pause, Play, Radar as RadarIcon, Sun } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import './RadarPanel.css'

interface RadarFrame {
  time: number
  path: string
}

interface RadarPayload {
  host: string
  frames: RadarFrame[]
}

/** RainViewer publishes a fresh weather-maps.json roughly every 10 minutes, so a short module-wide cache avoids refetching every time this slide is revisited during rotation. Mirrors the cache/inflight idiom in useSparkline.ts. */
const cache: { payload: RadarPayload | null; fetchedAt: number } = { payload: null, fetchedAt: 0 }
let inflight: Promise<RadarPayload | null> | null = null
const CACHE_TTL_MS = 5 * 60_000
const FRAME_COUNT = 8
const FRAME_INTERVAL_MS = 700
/** Extra beat on the newest frame so the loop reads as "…and here is now" rather than a blur. */
const LAST_FRAME_HOLD_MS = 1_400
const TILE_SIZE = 256
// z9 puts roughly a 120 km box around the house on a wall panel — close enough to recognise your own
// side of town, wide enough to see a storm arriving. z7 showed three states and read as a map of
// somewhere else.
const ZOOM = 9
const BASEMAP_URL = 'https://basemaps.cartocdn.com/dark_all'
/** Below this chance across the next day, "radar" has nothing to say and the panel pivots. */
const QUIET_RAIN_CHANCE = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function parseFrames(payload: unknown): RadarPayload | null {
  if (!isRecord(payload)) return null
  const host = String(payload.host ?? '')
  const radar = isRecord(payload.radar) ? payload.radar : null
  const past = Array.isArray(radar?.past) ? radar.past : []
  const frames: RadarFrame[] = past
    .filter(isRecord)
    .map((item) => ({ time: Number(item.time), path: String(item.path ?? '') }))
    .filter((frame): frame is RadarFrame => Number.isFinite(frame.time) && frame.path.length > 0)
    .slice(-FRAME_COUNT)
  if (!host || frames.length === 0) return null
  return { host, frames }
}

function fetchRadarFrames(): Promise<RadarPayload | null> {
  if (cache.payload && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cache.payload)
  if (inflight) return inflight
  const request = fetch('https://api.rainviewer.com/public/weather-maps.json')
    .then((response) => (response.ok ? response.json() : null))
    .then((data: unknown) => {
      const parsed = parseFrames(data)
      if (parsed) {
        cache.payload = parsed
        cache.fetchedAt = Date.now()
      }
      return parsed
    })
    .catch(() => null)
    .finally(() => { inflight = null })
  inflight = request
  return request
}

/**
 * Web Mercator world-pixel coordinates at ZOOM. Working in pixels rather than whole tiles is what
 * lets the home location sit exactly at the centre of the panel: the tile grid is then offset by
 * the sub-tile remainder instead of snapping to a tile boundary.
 */
function lonToWorldX(lon: number) {
  return ((lon + 180) / 360) * TILE_SIZE * 2 ** ZOOM
}

function latToWorldY(lat: number) {
  const clamped = Math.max(-85.05, Math.min(85.05, lat))
  const latRad = (clamped * Math.PI) / 180
  return ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * TILE_SIZE * 2 ** ZOOM
}

function formatFrameClock(unixSeconds: number) {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export interface RadarOutlook {
  /** Highest rain chance (%) across the coming day, or null when unknown. */
  peakRainChance: number | null
  /** Hour label of that peak, e.g. "4 PM". */
  peakRainHour: string | null
  /** Next calendar day with a meaningful rain chance, e.g. "Thu 60%". */
  nextWetDay: string | null
  uvMax: number | null
  windGusts: number | null
  sunrise: string | null
  sunset: string | null
  airQuality: string | null
}

interface RadarPanelProps {
  latitude: number | null
  longitude: number | null
  outlook?: RadarOutlook
}

interface TilePlacement {
  key: string
  /** Wrapped column used in tile URLs. */
  x: number
  y: number
  left: number
  top: number
}

/** Every tile needed to cover a width x height viewport centred on the home coordinate. */
function planTiles(width: number, height: number, latitude: number, longitude: number): TilePlacement[] {
  const worldTiles = 2 ** ZOOM
  const centerX = lonToWorldX(longitude)
  const centerY = latToWorldY(latitude)
  const originX = centerX - width / 2
  const originY = centerY - height / 2

  const firstCol = Math.floor(originX / TILE_SIZE)
  const lastCol = Math.floor((originX + width) / TILE_SIZE)
  const firstRow = Math.floor(originY / TILE_SIZE)
  const lastRow = Math.floor((originY + height) / TILE_SIZE)

  const placements: TilePlacement[] = []
  for (let row = firstRow; row <= lastRow; row++) {
    // Above the north pole / below the south pole there is no tile to draw.
    if (row < 0 || row >= worldTiles) continue
    for (let col = firstCol; col <= lastCol; col++) {
      // Longitude wraps, so a viewport straddling the antimeridian reuses tiles from the far side.
      const wrappedCol = ((col % worldTiles) + worldTiles) % worldTiles
      placements.push({
        key: `${row}-${col}`,
        x: wrappedCol,
        y: row,
        left: col * TILE_SIZE - originX,
        top: row * TILE_SIZE - originY,
      })
    }
  }
  return placements
}

export function RadarPanel({ latitude, longitude, outlook }: RadarPanelProps) {
  const [payload, setPayload] = useState<RadarPayload | null>(cache.payload)
  const [loadFailed, setLoadFailed] = useState(false)
  const [frameIndex, setFrameIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const scopeRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let stopped = false
    fetchRadarFrames().then((result) => {
      if (stopped) return
      if (result) {
        setPayload(result)
        setLoadFailed(false)
      } else {
        setLoadFailed(true)
      }
    })
    return () => { stopped = true }
  }, [])

  // The tile grid is sized from the rendered box, so the radar fills whatever rectangle the
  // weather panel gives it instead of being letterboxed into a square.
  useEffect(() => {
    const element = scopeRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect
      setSize({ width: Math.ceil(box.width), height: Math.ceil(box.height) })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const frames = payload?.frames ?? []
  // Frame count only changes right after a refetch; deriving the in-range index at render time
  // avoids a setState-in-effect just to clamp it.
  const displayIndex = frames.length ? frameIndex % frames.length : 0
  const isNewestFrame = frames.length > 0 && displayIndex === frames.length - 1

  useEffect(() => {
    if (!playing || frames.length < 2) return
    const timer = window.setTimeout(() => {
      setFrameIndex((current) => (current + 1) % frames.length)
    }, isNewestFrame ? LAST_FRAME_HOLD_MS : FRAME_INTERVAL_MS)
    return () => window.clearTimeout(timer)
  }, [playing, frames.length, displayIndex, isNewestFrame])

  const currentFrame = frames[displayIndex] ?? null
  const hasLocation = latitude !== null && longitude !== null
  const tiles = hasLocation && size.width > 0 && size.height > 0
    ? planTiles(size.width, size.height, latitude, longitude)
    : []

  const statusLabel = !hasLocation
    ? 'Waiting for home location'
    : currentFrame
      ? `As of ${formatFrameClock(currentFrame.time)}`
      : loadFailed ? 'Radar unavailable' : 'Loading radar...'

  // With nothing falling anywhere nearby, an empty radar loop is just a dark map. The same panel
  // then reports the things that actually matter on a dry day.
  const quiet = outlook !== undefined
    && (outlook.peakRainChance === null || outlook.peakRainChance < QUIET_RAIN_CHANCE)

  const quietFacts = quiet && outlook
    ? [
      { label: 'Next wet day', value: outlook.nextWetDay ?? 'None in 7 days' },
      { label: 'UV max today', value: outlook.uvMax === null ? '--' : outlook.uvMax.toFixed(1) },
      { label: 'Gusts', value: outlook.windGusts === null ? '--' : String(Math.round(outlook.windGusts)) },
      { label: 'Sunrise', value: outlook.sunrise ?? '--' },
      { label: 'Sunset', value: outlook.sunset ?? '--' },
      ...(outlook.airQuality ? [{ label: 'Outdoor AQI', value: outlook.airQuality }] : []),
    ]
    : []

  return (
    <section className="weather-panel radar-panel" aria-label="Precipitation radar">
      <header className="weather-panel-heading compact">
        <strong>{quiet ? 'Radar clear' : 'Precipitation radar'}</strong>
        <span>{statusLabel}</span>
      </header>
      <div className="radar-scope" ref={scopeRef}>
        {tiles.length > 0 && (
          <div className="radar-layer radar-basemap" aria-hidden="true">
            {tiles.map((tile) => (
              <img
                key={`base-${tile.key}`}
                src={`${BASEMAP_URL}/${ZOOM}/${tile.x}/${tile.y}.png`}
                alt=""
                style={{ left: tile.left, top: tile.top }}
                loading="eager"
              />
            ))}
          </div>
        )}
        {tiles.length > 0 && currentFrame && payload && (
          <div className="radar-layer radar-precip" aria-hidden="true">
            {tiles.map((tile) => (
              <img
                key={`radar-${tile.key}-${currentFrame.time}`}
                src={`${payload.host}${currentFrame.path}/${TILE_SIZE}/${ZOOM}/${tile.x}/${tile.y}/4/1_1.png`}
                alt=""
                style={{ left: tile.left, top: tile.top }}
                loading="eager"
              />
            ))}
          </div>
        )}
        {/* Circular range rings read wrong on a rectangular map crop; a plain home marker is enough. */}
        <div className="radar-rings" aria-hidden="true">
          <span className="radar-home-dot" />
        </div>
        {(!currentFrame || !hasLocation) && (
          <div className="radar-loading">
            {!hasLocation ? 'Home coordinates are not available yet' : loadFailed ? 'Radar data unavailable' : 'Loading radar frames…'}
          </div>
        )}
        <span className="radar-attribution">© OpenStreetMap · CARTO</span>
      </div>
      {quiet && (
        <div className="radar-quiet" role="status">
          <p className="radar-quiet-lead">
            <Sun size={16} aria-hidden="true" />
            No precipitation in range or in the next 24 hours
            {outlook?.peakRainHour && outlook.peakRainChance !== null
              ? ` — highest chance ${Math.round(outlook.peakRainChance)}% around ${outlook.peakRainHour}`
              : ''}
          </p>
          <div className="radar-quiet-grid">
            {quietFacts.map((fact) => (
              <div key={fact.label}>
                <span>{fact.label}</span>
                <strong>{fact.value}</strong>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="radar-controls">
        <button
          type="button"
          className="radar-play-toggle"
          onClick={() => setPlaying((current) => !current)}
          disabled={frames.length < 2}
          title={playing ? 'Pause radar animation' : 'Play radar animation'}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
          <span>{playing ? 'Pause' : 'Play'}</span>
        </button>
        <div className="radar-frame-dots" aria-label="Radar animation frames">
          {frames.map((frame, index) => (
            <span key={frame.time} className={index === displayIndex ? 'is-active' : ''} />
          ))}
        </div>
        <span className="radar-source"><RadarIcon size={12} aria-hidden="true" /> RainViewer</span>
      </div>
    </section>
  )
}
