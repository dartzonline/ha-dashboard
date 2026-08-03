import { useCallback, useEffect, useState } from 'react'
import { apiUrl } from './api'
import type { HAEntity, HealthResponse } from './types'

export type ServiceState = 'ok' | 'degraded' | 'down' | 'unconfigured' | 'checking'

export interface ServiceStatus {
  id: string
  label: string
  state: ServiceState
  /** One line on what the service is doing right now. */
  detail: string
  /** What to actually do about it — only set when there is a concrete next step. */
  hint?: string
}

/** Worst state wins, so one collapsed indicator can stand in for the whole list. */
const SEVERITY: Record<ServiceState, number> = { ok: 0, checking: 1, unconfigured: 2, degraded: 3, down: 4 }

export function worstState(services: ServiceStatus[]): ServiceState {
  return services.reduce<ServiceState>(
    (worst, service) => (SEVERITY[service.state] > SEVERITY[worst] ? service.state : worst),
    'ok',
  )
}

/** Home lat/lon as Home Assistant publishes it, shared with the header aircraft badge. */
export function homeCoordinates(entities: Map<string, HAEntity>) {
  const source = entities.get('weather.forecast_home') ?? entities.get('zone.home')
  const latitude = Number(source?.attributes.latitude)
  const longitude = Number(source?.attributes.longitude)
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

/**
 * The flight board degrades to an empty list no matter what goes wrong upstream, so a quiet sky
 * and a missing API key look identical on screen. This is where that gets named — including the
 * anonymous-tier rate limiting that silently emptied the board for a whole release.
 */
function readFlights(payload: unknown): ServiceStatus[] {
  if (!isRecord(payload)) {
    return [{ id: 'flights', label: 'Flights', state: 'down', detail: 'Status unavailable' }]
  }
  const opensky = isRecord(payload.opensky) ? payload.opensky : {}
  const airlabs = isRecord(payload.airlabs) ? payload.airlabs : {}
  const errors = isRecord(payload.lastErrors) ? payload.lastErrors : {}
  const statesError = isRecord(errors.opensky_states) ? String(errors.opensky_states.detail ?? '') : ''
  const rateLimited = statesError.includes('429')

  let positions: ServiceStatus
  if (!opensky.configured) {
    positions = {
      id: 'opensky',
      label: 'Flight positions',
      state: rateLimited ? 'degraded' : 'unconfigured',
      detail: rateLimited ? 'Anonymous tier is rate limited' : 'Anonymous tier — no credentials set',
      hint: 'Set opensky_client_id and opensky_client_secret in the add-on’s Configuration tab to lift the rate limit',
    }
  } else if (!opensky.tokenOk) {
    positions = { id: 'opensky', label: 'Flight positions', state: 'down', detail: 'OpenSky rejected the credentials', hint: 'Re-check opensky_client_id and opensky_client_secret' }
  } else if (rateLimited) {
    positions = { id: 'opensky', label: 'Flight positions', state: 'degraded', detail: 'Rate limited by OpenSky — retrying' }
  } else if (!opensky.statesOk) {
    positions = { id: 'opensky', label: 'Flight positions', state: 'degraded', detail: 'OpenSky is not answering position queries' }
  } else {
    positions = { id: 'opensky', label: 'Flight positions', state: 'ok', detail: 'OpenSky live, with route history' }
  }

  return [
    positions,
    {
      id: 'airlabs',
      label: 'Flight schedules',
      state: airlabs.configured ? 'ok' : 'unconfigured',
      detail: airlabs.configured ? 'AirLabs schedules and delays' : 'Optional — no AirLabs key set',
      hint: airlabs.configured ? undefined : 'Add airlabs_key for scheduled times and delay status on tracked flights',
    },
  ]
}

async function probe(url: string, init?: RequestInit) {
  try {
    const response = await fetch(url, init)
    return response.ok
  } catch {
    return false
  }
}

/**
 * Everything the dashboard depends on, in one list. Only fetched while the panel is actually open:
 * this runs on a wall display 24/7, and polling four upstreams forever to keep a dot fresh is not
 * worth the traffic when the collapsed indicator already tracks Home Assistant from `health`.
 */
export function useServiceStatus(
  enabled: boolean,
  health: HealthResponse | null,
  entities: Map<string, HAEntity>,
) {
  const [external, setExternal] = useState<ServiceStatus[]>([])
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)

  const haServices: ServiceStatus[] = [
    health === null
      ? { id: 'ha', label: 'Home Assistant', state: 'checking', detail: 'Contacting the bridge…' }
      : !health.home_assistant.configured
        ? { id: 'ha', label: 'Home Assistant', state: 'unconfigured', detail: 'No connection details', hint: 'Set HA_URL and HA_TOKEN, or run this as a Home Assistant add-on' }
        : health.home_assistant.connected
          ? { id: 'ha', label: 'Home Assistant', state: 'ok', detail: `${entities.size} entities live` }
          : { id: 'ha', label: 'Home Assistant', state: 'down', detail: 'Bridge cannot reach Home Assistant' },
  ]

  const refresh = useCallback(async () => {
    const coordinates = homeCoordinates(entities)
    const [flights, weatherOk, radarOk] = await Promise.all([
      fetch(apiUrl('flights/status')).then((response) => (response.ok ? response.json() : null)).catch(() => null),
      coordinates
        ? probe(apiUrl(`weather/external?latitude=${coordinates.latitude}&longitude=${coordinates.longitude}`))
        : Promise.resolve(false),
      probe('https://api.rainviewer.com/public/weather-maps.json'),
    ])

    setExternal([
      ...readFlights(flights),
      {
        id: 'weather',
        label: 'Weather',
        state: !coordinates ? 'unconfigured' : weatherOk ? 'ok' : 'down',
        detail: !coordinates
          ? 'Home coordinates not published by Home Assistant'
          : weatherOk ? 'Open-Meteo forecast' : 'Open-Meteo is not responding',
      },
      {
        id: 'radar',
        label: 'Rain radar',
        state: radarOk ? 'ok' : 'down',
        detail: radarOk ? 'RainViewer frames' : 'RainViewer is not responding',
      },
    ])
    setCheckedAt(new Date())
  }, [entities])

  useEffect(() => {
    if (!enabled) return
    let stopped = false
    const run = () => { if (!stopped) void refresh() }
    queueMicrotask(run)
    // Slow refresh so a panel left open on the wall does not go stale, without hammering upstreams.
    const timer = window.setInterval(run, 60_000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [enabled, refresh])

  const services = [...haServices, ...external]
  return { services, overall: worstState(services), checkedAt, refresh }
}
