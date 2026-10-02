import { MapPinOff, Minus, Pause, Play, Plus, Radar as RadarIcon, Sun } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cachedJson, isAbortError, peekCached } from './cachedFetch'
import { EmptyState, InlineError, LoadingState } from './ui/StateMessages'
import './RadarPanel.css'

interface RadarFrame {
  time: number
  path: string
}

interface RadarPayload {
  host: string
  frames: RadarFrame[]
}

/** RainViewer publishes a fresh weather-maps.json roughly every 10 minutes, so the shared JSON cache
    keeps this slide from refetching every time rotation brings it back. Only the frame index is
    cached; the tiles themselves are images the browser's HTTP cache already handles. */
const RADAR_CACHE_KEY = 'rainviewer:weather-maps'
const CACHE_TTL_MS = 5 * 60_000
const FRAME_COUNT = 8
const FRAME_INTERVAL_MS = 700
/** Extra beat on the newest frame so the loop reads as "…and here is now" rather than a blur. */
const LAST_FRAME_HOLD_MS = 1_400
const TILE_SIZE = 256
// z9 puts roughly a 120 km box around the house on a wall panel — close enough to recognise your own
// side of town, wide enough to see a storm arriving. z7 showed three states and read as a map of
// somewhere else. This is the basemap's zoom; the precipitation layer below has its own, lower zoom.
const BASEMAP_ZOOM = 9
// RainViewer's radar tile server only actually rasterizes zoom levels up to 7 — anything past that
// (we were requesting z9, matching the basemap) 200s with a real PNG, but the PNG is a placeholder
// that reads "Zoom Level Not Supported", so the radar layer silently never showed precipitation.
// Fetched at its own zoom and scaled up in CSS to line up with the basemap's finer grid below.
const PRECIP_ZOOM = 7
const PRECIP_SOURCE_SIZE = 512
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

/** Throws rather than resolving null, so an empty or broken index is never cached as the answer. */
function fetchRadarFrames(options: { signal?: AbortSignal; force?: boolean }): Promise<RadarPayload> {
  return cachedJson<RadarPayload>(RADAR_CACHE_KEY, async () => {
    const response = await fetch('https://api.rainviewer.com/public/weather-maps.json')
    if (!response.ok) throw new Error(`RainViewer unavailable (${response.status})`)
    const parsed = parseFrames(await response.json())
    if (!parsed) throw new Error('RainViewer returned no radar frames')
    return parsed
  }, CACHE_TTL_MS, options)
}

/**
 * Web Mercator world-pixel coordinates at a given zoom. Working in pixels rather than whole tiles
 * is what lets the home location sit exactly at the centre of the panel: the tile grid is then
 * offset by the sub-tile remainder instead of snapping to a tile boundary.
 */
function lonToWorldX(lon: number, zoom: number) {
  return ((lon + 180) / 360) * TILE_SIZE * 2 ** zoom
}

function latToWorldY(lat: number, zoom: number) {
  const clamped = Math.max(-85.05, Math.min(85.05, lat))
  const latRad = (clamped * Math.PI) / 180
  return ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * TILE_SIZE * 2 ** zoom
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

/**
 * Every tile needed to cover a width x height viewport centred on the home coordinate, at the
 * given zoom. `scale` blows each tile up to line up with a different, finer-zoomed layer sharing
 * the same viewport — a precip tile fetched at `BASEMAP_ZOOM - PRECIP_ZOOM` fewer zoom levels
 * covers `scale`x the area of one basemap tile, so it is placed and sized `scale`x larger.
 */
function planTiles(width: number, height: number, latitude: number, longitude: number, zoom: number, scale = 1): TilePlacement[] {
  const worldTiles = 2 ** zoom
  const cssTile = TILE_SIZE * scale
  const centerX = lonToWorldX(longitude, zoom) * scale
  const centerY = latToWorldY(latitude, zoom) * scale
  const originX = centerX - width / 2
  const originY = centerY - height / 2

  const firstCol = Math.floor(originX / cssTile)
  const lastCol = Math.floor((originX + width) / cssTile)
  const firstRow = Math.floor(originY / cssTile)
  const lastRow = Math.floor((originY + height) / cssTile)

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
        left: col * cssTile - originX,
        top: row * cssTile - originY,
      })
    }
  }
  return placements
}

export function RadarPanel({ latitude, longitude, outlook }: RadarPanelProps) {
  const [payload, setPayload] = useState<RadarPayload | null>(() => peekCached<RadarPayload>(RADAR_CACHE_KEY) ?? null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [frameIndex, setFrameIndex] = useState(-1)
  const [playing, setPlaying] = useState(true)
  const [zoom, setZoom] = useState(BASEMAP_ZOOM)
  const [loadedTiles, setLoadedTiles] = useState<Set<string>>(() => new Set())
  const [imageFailed, setImageFailed] = useState(false)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const scopeRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const abort = new AbortController()
    fetchRadarFrames({ signal: abort.signal, force: attempt > 0 })
      .then((result) => {
        setPayload(result)
        setLoadFailed(false)
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) setLoadFailed(true)
      })
    return () => abort.abort()
  }, [attempt])

  function retry() {
    setLoadFailed(false)
    setImageFailed(false)
    setLoadedTiles(new Set())
    setAttempt((current) => current + 1)
  }

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
  const displayIndex = frames.length ? (frameIndex < 0 ? frames.length - 1 : frameIndex % frames.length) : 0
  const isNewestFrame = frames.length > 0 && displayIndex === frames.length - 1

  const currentFrame = frames[displayIndex] ?? null
  const hasLocation = latitude !== null && longitude !== null
  const hasViewport = hasLocation && size.width > 0 && size.height > 0
  const tiles = hasViewport
    ? planTiles(size.width, size.height, latitude, longitude, zoom)
    : []
  const precipZoom = Math.min(zoom, PRECIP_ZOOM)
  const precipScale = 2 ** (zoom - precipZoom)
  const precipTiles = hasViewport
    ? planTiles(size.width, size.height, latitude, longitude, precipZoom, precipScale)
    : []

  function tileUrl(frame: RadarFrame, tile: TilePlacement) {
    return `${payload?.host}${frame.path}/${PRECIP_SOURCE_SIZE}/${precipZoom}/${tile.x}/${tile.y}/4/1_1.png`
  }
  const frameReady = Boolean(currentFrame && precipTiles.length && precipTiles.every((tile) => loadedTiles.has(tileUrl(currentFrame, tile))))
  const nextFrame = frames[(displayIndex + 1) % frames.length]
  const nextFrameReady = Boolean(nextFrame && precipTiles.length && precipTiles.every((tile) => loadedTiles.has(tileUrl(nextFrame, tile))))

  useEffect(() => {
    if (!playing || frames.length < 2 || !frameReady || !nextFrameReady || imageFailed) return
    const timer = window.setTimeout(() => {
      setFrameIndex((displayIndex + 1) % frames.length)
    }, isNewestFrame ? LAST_FRAME_HOLD_MS : FRAME_INTERVAL_MS)
    return () => window.clearTimeout(timer)
  }, [playing, frames.length, displayIndex, isNewestFrame, frameReady, nextFrameReady, imageFailed])

  // Loading and failure are drawn over the map itself, so the heading only carries the frame time.
  const statusLabel = hasLocation && currentFrame ? `As of ${formatFrameClock(currentFrame.time)}` : null

  // With nothing falling anywhere nearby, an empty radar loop is just a dark map. The same panel
  // then reports the things that actually matter on a dry day.
  const quiet = outlook !== undefined
    && outlook.peakRainChance !== null && outlook.peakRainChance < QUIET_RAIN_CHANCE

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
    <section className="weather-panel weather-radar-panel" aria-label="Precipitation radar" data-swipe-ignore>
      <header className="weather-panel-heading">
        <h3>Precipitation radar</h3>
        {statusLabel && <span>{statusLabel}</span>}
      </header>
      <div className="weather-radar-scope" ref={scopeRef}>
        {tiles.length > 0 && (
          <div className="radar-layer radar-basemap" aria-hidden="true">
            {tiles.map((tile) => (
              <img
                key={`base-${tile.key}-${zoom}-${attempt}`}
                // @2x pulls a 512px source into a 256 CSS-px tile, so city-name labels render at
                // retina sharpness instead of the visible upscaling blur a 1x tile shows at this size.
                src={`${BASEMAP_URL}/${zoom}/${tile.x}/${tile.y}@2x.png`}
                alt=""
                onError={() => setImageFailed(true)}
                style={{ left: tile.left, top: tile.top }}
                loading="eager"
              />
            ))}
          </div>
        )}
        {precipTiles.length > 0 && payload && frames.map((frame) => (
          <div key={`${frame.path}-${attempt}`} className="radar-layer radar-precip" aria-hidden="true" style={{ visibility: frame.time === currentFrame?.time ? 'visible' : 'hidden' }}>
            {precipTiles.map((tile) => (
              <img
                key={`radar-${tile.key}-${precipZoom}`}
                src={tileUrl(frame, tile)}
                alt=""
                onLoad={(event) => {
                  const source = event.currentTarget.src
                  setLoadedTiles((current) => current.has(source) ? current : new Set([...current, source]))
                }}
                onError={() => setImageFailed(true)}
                style={{ left: tile.left, top: tile.top, width: TILE_SIZE * precipScale, height: TILE_SIZE * precipScale }}
                loading="eager"
              />
            ))}
          </div>
        ))}
        {/* Circular range rings read wrong on a rectangular map crop; a plain home marker is enough. */}
        <div className="radar-rings" aria-hidden="true">
          <span className="radar-home-dot" />
        </div>
        {(!currentFrame || !hasLocation || imageFailed || !frameReady) && (
          <div className="radar-overlay">
            {!hasLocation
              ? <EmptyState size="compact" icon={<MapPinOff />} title="Home location not available" hint="Looks for latitude and longitude on the weather.* entity or on zone.home" />
              : loadFailed || imageFailed
                ? <InlineError message={imageFailed ? 'Map or radar tiles unavailable' : 'Radar data unavailable'} onRetry={retry} />
                : <LoadingState size="compact" label={currentFrame ? 'Loading radar imagery' : 'Loading radar frames'} />}
          </div>
        )}
        <span className="radar-attribution on-glass-text">© OpenStreetMap · CARTO</span>
        <div className="radar-zoom">
          <button type="button" className="glass-pill" title="Zoom in" aria-label="Zoom in radar" disabled={!hasLocation || zoom >= 10} onClick={() => setZoom((current) => current + 1)}><Plus size={18} aria-hidden="true" /></button>
          <button type="button" className="glass-pill" title="Zoom out" aria-label="Zoom out radar" disabled={!hasLocation || zoom <= 6} onClick={() => setZoom((current) => current - 1)}><Minus size={18} aria-hidden="true" /></button>
        </div>
      </div>
      {quiet && (
        <details className="radar-quiet">
          <summary className="radar-quiet-lead">
            <Sun size={16} aria-hidden="true" />
            Low forecast rain chance in the next 24 hours
            {outlook?.peakRainHour && outlook.peakRainChance !== null
              ? ` — highest chance ${Math.round(outlook.peakRainChance)}% around ${outlook.peakRainHour}`
              : ''}
          </summary>
          <div className="radar-quiet-grid">
            {quietFacts.map((fact) => (
              <div key={fact.label}>
                <span>{fact.label}</span>
                <strong>{fact.value}</strong>
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="radar-controls" role="group" aria-label="Radar playback">
        <button
          type="button"
          className="radar-play-toggle glass-pill"
          onClick={() => setPlaying((current) => !current)}
          disabled={frames.length < 2 || !hasLocation || imageFailed}
          title={playing ? 'Pause radar animation' : 'Play radar animation'}
          aria-label={playing ? 'Pause radar animation' : 'Play radar animation'}
        >
          {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
        </button>
        <input className="radar-timeline" type="range" min={0} max={Math.max(0, frames.length - 1)} value={displayIndex} disabled={frames.length < 2 || !hasLocation} aria-label="Radar time" aria-valuetext={currentFrame ? formatFrameClock(currentFrame.time) : 'No radar frames'} onChange={(event) => { setPlaying(false); setFrameIndex(Number(event.target.value)) }} />
        <span className="radar-source"><RadarIcon size={12} aria-hidden="true" /><span>RainViewer</span></span>
      </div>
    </section>
  )
}
