import { useEffect, useEffectEvent, useState } from 'react'
import { apiUrl, timeoutSignal, webSocketUrl } from './api'
import type { HAEntity, NightModeResponse } from './types'
import { useHealth } from './useHealth'

/** First retry after a drop; doubled with jitter up to the ceiling, reset once a socket opens. */
const RECONNECT_MIN_MS = 3_000
const RECONNECT_MAX_MS = 30_000
const FETCH_TIMEOUT_MS = 15_000
/** No frame for this long while the bridge claims to be connected means the socket is dead, not idle. */
const HEARTBEAT_MS = 120_000
const HEARTBEAT_CHECK_MS = 15_000
/** A socket closed longer than this is a real outage rather than a reconnect blip. */
const STALE_AFTER_MS = 5_000

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'stale'

export interface HAStateChange {
  id: number
  entity: HAEntity
  previousState: string
}

type SocketPhase = 'connecting' | 'open' | 'closed' | 'lost'

let lastEventId = 0

/** Monotonic ids for alerts and log entries. `Date.now()` collided when one WS frame carried several changes. */
export function nextEventId() {
  lastEventId += 1
  return lastEventId
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function updatedAt(entity: HAEntity) {
  const parsed = Date.parse(entity.last_updated ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Folds a fresh `/api/states` snapshot into the live map without discarding WebSocket events that
 * landed while the fetch was in flight: for every entity the newer `last_updated` wins, and an
 * entity the snapshot lacks survives only if it changed after the fetch began (it was just created).
 */
export function mergeStates(current: Map<string, HAEntity>, fetched: HAEntity[], fetchStartedAt: number): Map<string, HAEntity> {
  const next = new Map<string, HAEntity>()
  for (const entity of fetched) {
    if (!entity?.entity_id) continue
    const live = current.get(entity.entity_id)
    next.set(entity.entity_id, live && updatedAt(live) > updatedAt(entity) ? live : entity)
  }
  for (const [entityId, entity] of current) {
    if (!next.has(entityId) && updatedAt(entity) >= fetchStartedAt) next.set(entityId, entity)
  }
  return next
}

export function useHomeAssistant(onStateChange?: (change: HAStateChange) => void) {
  const [entities, setEntities] = useState<Map<string, HAEntity>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [socketPhase, setSocketPhase] = useState<SocketPhase>('connecting')
  const [bridgeConnected, setBridgeConnected] = useState<boolean | null>(null)
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null)
  const { health, reachable: backendReachable } = useHealth()

  const mergeEntity = useEffectEvent((entity: HAEntity | null | undefined, previousState = '') => {
    if (!entity?.entity_id) return
    setEntities((current) => new Map(current).set(entity.entity_id, entity))
    if (previousState && previousState !== entity.state) {
      onStateChange?.({ id: nextEventId(), entity, previousState })
    }
  })

  // Read from inside the heartbeat interval, so it always sees the current health rather than the
  // snapshot from when the socket effect first ran.
  const bridgeClaimsConnected = useEffectEvent(() => health?.home_assistant.connected === true)

  useEffect(() => {
    let stopped = false
    let socket: WebSocket | undefined
    let hadOpened = false
    let lastFrameAt = Date.now()
    let reconnectTimer: number | undefined
    let retryTimer: number | undefined
    let staleTimer: number | undefined
    let reconnectDelay = RECONNECT_MIN_MS
    let retryDelay = RECONNECT_MIN_MS

    function markFrame() {
      lastFrameAt = Date.now()
      setLastMessageAt(lastFrameAt)
    }

    async function load() {
      if (retryTimer) window.clearTimeout(retryTimer)
      retryTimer = undefined
      const startedAt = Date.now()
      try {
        // A hung fetch on a kiosk would otherwise never reach the retry path below.
        const response = await fetch(apiUrl('states'), { signal: timeoutSignal(FETCH_TIMEOUT_MS) })
        if (!response.ok) throw new Error('Home Assistant states are unavailable')
        const states: HAEntity[] = await response.json()
        if (stopped) return
        setEntities((current) => mergeStates(current, states, startedAt))
        setError(null)
        retryDelay = RECONNECT_MIN_MS
      } catch (requestError) {
        if (stopped) return
        setError(requestError instanceof Error && requestError.name !== 'TimeoutError' && requestError.name !== 'AbortError'
          ? requestError.message
          : 'Backend unavailable')
        // Self-heals on a wall-mounted kiosk that nobody will manually reload after a transient outage.
        retryTimer = window.setTimeout(() => void load(), retryDelay)
        retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_MS)
      } finally {
        if (!stopped) setLoading(false)
      }
    }

    function scheduleReconnect() {
      if (stopped || reconnectTimer) return
      // Jitter keeps a house full of tablets from reconnecting in lockstep after a router reboot.
      const delay = reconnectDelay + Math.random() * reconnectDelay * 0.5
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined
        connect()
      }, delay)
    }

    function connect() {
      if (stopped) return
      const ws = new WebSocket(webSocketUrl('ws'))
      socket = ws

      ws.onopen = () => {
        if (socket !== ws) return
        reconnectDelay = RECONNECT_MIN_MS
        if (staleTimer) window.clearTimeout(staleTimer)
        staleTimer = undefined
        markFrame()
        setSocketPhase('open')
        // Events that fired while the socket was down are gone; only a fresh snapshot recovers them.
        if (hadOpened) void load()
        hadOpened = true
      }

      ws.onmessage = (event) => {
        if (socket !== ws) return
        markFrame()
        let message: unknown
        try {
          message = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (!isRecord(message)) return
        if (message.type === 'ready') return
        if (message.type === 'bridge') {
          setBridgeConnected(message.connected === true)
          return
        }
        if (message.type === 'resync') {
          // The backend reconnected to Home Assistant; whatever changed in between never reached us.
          void load()
          return
        }
        const envelope = isRecord(message.event) && isRecord(message.event.data)
          ? message.event.data
          : isRecord(message.data) ? message.data : message
        const newState = envelope.new_state
        const oldState = envelope.old_state
        mergeEntity(
          isRecord(newState) ? (newState as unknown as HAEntity) : null,
          isRecord(oldState) && typeof oldState.state === 'string' ? oldState.state : '',
        )
      }

      ws.onclose = () => {
        if (socket !== ws || stopped) return
        setSocketPhase('closed')
        if (!staleTimer) staleTimer = window.setTimeout(() => setSocketPhase('lost'), STALE_AFTER_MS)
        scheduleReconnect()
      }

      ws.onerror = () => {
        // The browser always follows an error with close; the reconnect is scheduled there.
      }
    }

    // A half-open TCP connection delivers nothing and never fires onclose; closing it ourselves
    // turns silence into the ordinary reconnect path.
    const heartbeat = window.setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      if (bridgeClaimsConnected() && Date.now() - lastFrameAt > HEARTBEAT_MS) socket.close()
    }, HEARTBEAT_CHECK_MS)

    void load()
    connect()
    return () => {
      stopped = true
      window.clearInterval(heartbeat)
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      if (retryTimer) window.clearTimeout(retryTimer)
      if (staleTimer) window.clearTimeout(staleTimer)
      socket?.close()
    }
  }, [])

  async function requestJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => null)
      throw new Error(detail?.detail ?? `Action failed (${response.status})`)
    }
    return response.json()
  }

  async function callService(domain: string, service: string, data: Record<string, unknown>) {
    await requestJson<unknown>(`services/${domain}/${service}`, data)
  }

  function runNightMode() {
    return requestJson<NightModeResponse>('actions/night-mode', { confirm: true })
  }

  const haDown = bridgeConnected === false || health?.home_assistant.connected === false || backendReachable === false
  const connection: ConnectionState = haDown || socketPhase === 'lost'
    ? 'stale'
    : socketPhase === 'closed'
      ? 'reconnecting'
      : socketPhase === 'open' ? 'live' : 'connecting'
  const authFailed = health?.home_assistant.auth_failed === true

  return {
    entities,
    health,
    loading,
    error,
    callService,
    runNightMode,
    /** One word for the header: `stale` means what is on screen may no longer be true. */
    connection,
    /** Epoch ms of the last WebSocket frame of any kind, or null before the first. */
    lastMessageAt,
    /** The backend's own word on whether it holds a Home Assistant connection; null until it says. */
    bridgeConnected,
    /** Home Assistant refused the backend's token; a banner, not a reconnect, is the fix. */
    authFailed,
  }
}
