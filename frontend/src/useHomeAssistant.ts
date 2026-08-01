import { useEffect, useEffectEvent, useState } from 'react'
import { apiUrl, webSocketUrl } from './api'
import type { HAEntity, HealthResponse, NightModeResponse } from './types'

const reconnectDelay = 3000

export interface HAStateChange {
  id: number
  entity: HAEntity
  previousState: string
}

export function useHomeAssistant(onStateChange?: (change: HAStateChange) => void) {
  const [entities, setEntities] = useState<Map<string, HAEntity>>(new Map())
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const mergeEntity = useEffectEvent((entity: HAEntity | null | undefined, previousState = '') => {
    if (!entity?.entity_id) return
    setEntities((current) => new Map(current).set(entity.entity_id, entity))
    if (previousState && previousState !== entity.state) {
      onStateChange?.({ id: Date.now(), entity, previousState })
    }
  })

  useEffect(() => {
    let stopped = false
    let socket: WebSocket | undefined
    let reconnectTimer: number | undefined

    async function load() {
      try {
        const [healthResponse, statesResponse] = await Promise.all([
          fetch(apiUrl('health')),
          fetch(apiUrl('states')),
        ])
        if (healthResponse.ok) setHealth(await healthResponse.json())
        if (!statesResponse.ok) throw new Error('Home Assistant states are unavailable')
        const states: HAEntity[] = await statesResponse.json()
        if (!stopped) {
          setEntities(new Map(states.map((entity) => [entity.entity_id, entity])))
          setError(null)
        }
      } catch (requestError) {
        if (!stopped) setError(requestError instanceof Error ? requestError.message : 'Backend unavailable')
      } finally {
        if (!stopped) setLoading(false)
      }
    }

    function connect() {
      socket = new WebSocket(webSocketUrl('ws'))
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data)
        const eventData = message.event?.data ?? message.data ?? message
        mergeEntity(eventData.new_state, eventData.old_state?.state ?? '')
      }
      socket.onclose = () => {
        if (!stopped) reconnectTimer = window.setTimeout(connect, reconnectDelay)
      }
    }

    void load()
    connect()
    return () => {
      stopped = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
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

  return { entities, health, loading, error, callService, runNightMode }
}
