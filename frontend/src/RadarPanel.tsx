import { Pause, Play, Radar as RadarIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
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
const FRAME_COUNT = 7
const FRAME_INTERVAL_MS = 600
const ZOOM = 7
const GRID = 3

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

/** Slippy-map tile math (Web Mercator): converts a lon/lat to the tile column/row containing it at a given zoom. */
function lonToTileX(lon: number, zoom: number) {
  const tileCount = 2 ** zoom
  return Math.floor(((lon + 180) / 360) * tileCount)
}

function latToTileY(lat: number, zoom: number) {
  const tileCount = 2 ** zoom
  const latRad = (lat * Math.PI) / 180
  return Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * tileCount)
}

function formatFrameClock(unixSeconds: number) {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

interface RadarPanelProps {
  latitude: number | null
  longitude: number | null
}

export function RadarPanel({ latitude, longitude }: RadarPanelProps) {
  const [payload, setPayload] = useState<RadarPayload | null>(cache.payload)
  const [loadFailed, setLoadFailed] = useState(false)
  const [frameIndex, setFrameIndex] = useState(0)
  const [playing, setPlaying] = useState(true)

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

  const frames = payload?.frames ?? []
  // Frame count only changes right after a refetch; deriving the in-range index at render time
  // avoids a setState-in-effect just to clamp it.
  const displayIndex = frames.length ? frameIndex % frames.length : 0

  useEffect(() => {
    if (!playing || frames.length < 2) return
    const timer = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % frames.length)
    }, FRAME_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [playing, frames.length])

  if (latitude === null || longitude === null) {
    return (
      <section className="weather-panel radar-panel" aria-label="Precipitation radar">
        <header className="weather-panel-heading compact">
          <strong>Precipitation radar</strong>
          <span>Waiting for home location</span>
        </header>
        <p className="forecast-empty">Home coordinates are not available yet.</p>
      </section>
    )
  }

  const centerX = lonToTileX(longitude, ZOOM)
  const centerY = latToTileY(latitude, ZOOM)
  const edgeOffset = Math.floor(GRID / 2)
  const tiles = Array.from({ length: GRID * GRID }, (_, index) => {
    const row = Math.floor(index / GRID)
    const col = index % GRID
    return { key: `${row}-${col}`, x: centerX - edgeOffset + col, y: centerY - edgeOffset + row }
  })

  const currentFrame = frames[displayIndex] ?? null
  const statusLabel = currentFrame ? `As of ${formatFrameClock(currentFrame.time)}` : loadFailed ? 'Radar unavailable' : 'Loading radar...'

  return (
    <section className="weather-panel radar-panel" aria-label="Precipitation radar">
      <header className="weather-panel-heading compact">
        <strong>Precipitation radar</strong>
        <span>{statusLabel}</span>
      </header>
      <div className="radar-scope">
        {payload && currentFrame && (
          <div className="radar-tile-grid">
            {tiles.map((tile) => (
              <img
                key={tile.key}
                className="radar-tile"
                src={`${payload.host}${currentFrame.path}/256/${ZOOM}/${tile.x}/${tile.y}/4/1_1.png`}
                alt=""
                aria-hidden="true"
                loading="eager"
              />
            ))}
          </div>
        )}
        <div className="radar-rings" aria-hidden="true">
          <span className="radar-ring ring-outer" />
          <span className="radar-ring ring-mid" />
          <span className="radar-ring ring-inner" />
          <span className="radar-home-dot" />
        </div>
        {!currentFrame && <div className="radar-loading">{loadFailed ? 'Radar data unavailable' : 'Loading radar frames…'}</div>}
      </div>
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
