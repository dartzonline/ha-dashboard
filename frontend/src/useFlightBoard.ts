import { useEffect, useSyncExternalStore } from 'react'
import { apiUrl } from './api'
import type { TrackSchedule } from './flightBadge'

/**
 * One poller for the flight endpoints, shared by the header badge and the Flights page.
 *
 * Each of those used to run its own timers, so with both mounted the backend -- and through it the
 * metered upstream APIs -- saw every request twice. The board lives at module level and the two
 * consumers subscribe to it; a single interval polls `flights/track` every 10 s and
 * `flights/nearby` every 30 s, and only while the tab is visible, since polling a dashboard nobody
 * is looking at is what exhausts the flight API quota. Becoming visible fetches immediately so the
 * panel never shows a full interval of stale data.
 */
export interface Aircraft {
  icao24: string
  callsign: string
  airline: string | null
  airlineCode: string | null
  type: string | null
  reg: string | null
  kind: 'jet' | 'heavy' | 'bizjet' | 'turboprop' | 'light' | 'heli' | string | null
  fromCode: string | null
  fromCity: string | null
  fromCountry: string | null
  toCode: string | null
  toCity: string | null
  toCountry: string | null
  altitudeFt: number | null
  speedKt: number | null
  verticalRateFpm: number | null
  onGround: boolean
  trackDeg: number | null
  bearingDeg: number | null
  distanceKm: number | null
  lat: number
  lon: number
}

export interface NearbyResponse {
  home: { lat: number; lon: number; rangeKm: number }
  updatedAt: string
  aircraft: Aircraft[]
}

export interface TrackRoute {
  fromCode: string | null
  fromCity: string | null
  /** Endpoint coordinates, present whenever the airport resolved to a known field. */
  fromLat?: number | null
  fromLon?: number | null
  toCode: string | null
  toCity: string | null
  toLat?: number | null
  toLon?: number | null
}

export interface TrackEntry {
  query: string | null
  mode: 'track' | 'landed' | 'await' | null
  flight: Aircraft | null
  route: TrackRoute | null
  schedule?: TrackSchedule
  /** 0..1 along the great-circle route, from the backend's own progress maths. */
  progress?: number
  /** Live time-to-run from ground speed as prose, e.g. "in 42 min"; the only ETA when no schedule exists. */
  etaLine?: string | null
  /** The same ETA as an absolute ISO-8601 UTC instant, formatted here in the tablet's own zone. */
  etaAt?: string | null
  minutesLeft?: number | null
  /** Real historical positions since departure, earliest first -- the actual flown track. */
  flownPath?: { lat: number; lon: number }[]
  /** Why a pinned flight has no live position yet -- set by the backend only while awaiting. */
  awaitReason?: string | null
}

/** The first pinned flight is flattened at the top level; `flights` lists every pin. */
export interface TrackResponse extends TrackEntry {
  flights?: TrackEntry[]
}

export interface HomeCoordinates {
  latitude: number
  longitude: number
}

export interface FlightBoard {
  track: TrackResponse | null
  /** Last failure fetching the tracked board; the previous board stays on screen meanwhile. */
  trackError: string | null
  nearby: NearbyResponse | null
  nearbyError: string | null
  trackFetchedAt: number | null
  nearbyFetchedAt: number | null
}

const TRACK_MS = 10_000
/** The backend caches nearby traffic for 60 s and OpenSky meters it; 30 s is as fast as is useful. */
const NEARBY_MS = 30_000
/** The header wants 25 to find the nearest airliner among the Cessnas; the page shows fewer. */
const NEARBY_LIMIT = 25

const EMPTY: FlightBoard = { track: null, trackError: null, nearby: null, nearbyError: null, trackFetchedAt: null, nearbyFetchedAt: null }

let board: FlightBoard = EMPTY
let home: HomeCoordinates | null = null
const listeners = new Set<() => void>()
let timer: number | undefined
let trackInflight = false
let nearbyInflight = false
let lastNearbyAttempt = 0

function publish(patch: Partial<FlightBoard>) {
  board = { ...board, ...patch }
  for (const listener of listeners) listener()
}

async function loadTrack() {
  if (trackInflight) return
  trackInflight = true
  try {
    const response = await fetch(apiUrl('flights/track'))
    if (!response.ok) throw new Error(`Track unavailable (${response.status})`)
    const payload: TrackResponse = await response.json()
    publish({ track: payload, trackError: null, trackFetchedAt: Date.now() })
  } catch (error) {
    // Keep the last known board on screen; the next poll retries.
    publish({ trackError: error instanceof Error ? error.message : 'Track unavailable' })
  } finally {
    trackInflight = false
  }
}

async function loadNearby() {
  if (!home || nearbyInflight) return
  nearbyInflight = true
  lastNearbyAttempt = Date.now()
  const { latitude, longitude } = home
  try {
    const response = await fetch(apiUrl(`flights/nearby?latitude=${latitude}&longitude=${longitude}&limit=${NEARBY_LIMIT}`))
    if (!response.ok) throw new Error(`Flight radar unavailable (${response.status})`)
    const payload: NearbyResponse = await response.json()
    publish({ nearby: payload, nearbyError: null, nearbyFetchedAt: Date.now() })
  } catch (error) {
    publish({ nearbyError: error instanceof Error ? error.message : 'Flight radar failed' })
  } finally {
    nearbyInflight = false
  }
}

function tick(force = false) {
  if (document.hidden) return
  void loadTrack()
  if (force || Date.now() - lastNearbyAttempt >= NEARBY_MS) void loadNearby()
}

function onVisibilityChange() {
  if (!document.hidden) tick(true)
}

function start() {
  if (timer !== undefined) return
  tick(true)
  timer = window.setInterval(() => tick(), TRACK_MS)
  document.addEventListener('visibilitychange', onVisibilityChange)
}

function stop() {
  if (timer !== undefined) window.clearInterval(timer)
  timer = undefined
  document.removeEventListener('visibilitychange', onVisibilityChange)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stop()
  }
}

function getSnapshot() {
  return board
}

/**
 * Tells the poller where home is. Null is ignored rather than clearing: a consumer without
 * coordinates (a page rendered before the entities arrive) must not blind one that has them.
 */
export function setHomeCoordinates(coordinates: HomeCoordinates | null) {
  if (!coordinates) return
  if (home && home.latitude === coordinates.latitude && home.longitude === coordinates.longitude) return
  home = coordinates
  if (timer !== undefined) void loadNearby()
}

/** After a pin/unpin the backend answers with the new board; put it up now rather than at the next poll. */
export function publishTrack(track: TrackResponse | null) {
  publish({ track, trackError: null, trackFetchedAt: Date.now() })
}

/** Immediate refetch of everything, e.g. after a mutation the caller could not read the reply of. */
export function refreshFlightBoard() {
  tick(true)
}

/** Test hook: forgets the board and stops any poller. */
export function resetFlightBoard() {
  stop()
  listeners.clear()
  board = EMPTY
  home = null
  trackInflight = false
  nearbyInflight = false
  lastNearbyAttempt = 0
}

export function useFlightBoard(coordinates: HomeCoordinates | null): FlightBoard {
  const latitude = coordinates?.latitude ?? null
  const longitude = coordinates?.longitude ?? null
  useEffect(() => {
    setHomeCoordinates(latitude !== null && longitude !== null ? { latitude, longitude } : null)
  }, [latitude, longitude])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
