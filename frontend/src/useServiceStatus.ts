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

/**
 * Home lat/lon as Home Assistant publishes it, shared with the header aircraft badge.
 *
 * Each candidate is tested for usable coordinates rather than picking the first entity that
 * merely exists: `weather.forecast_home` is present on this install but publishes no latitude,
 * so choosing it and stopping there yielded "no home location" even though `zone.home` had them
 * all along -- which silently hid the aircraft badge entirely.
 */
export function homeCoordinates(entities: Map<string, HAEntity>) {
  const candidates = [
    entities.get('weather.forecast_home'),
    entities.get('zone.home'),
    ...Array.from(entities.values()).filter((entity) => entity.entity_id.startsWith('zone.') || entity.entity_id.startsWith('weather.')),
  ]
  for (const candidate of candidates) {
    const latitude = Number(candidate?.attributes.latitude)
    const longitude = Number(candidate?.attributes.longitude)
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) return { latitude, longitude }
  }
  return null
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
  const fallback = isRecord(payload.fallback) ? payload.fallback : {}
  const errors = isRecord(payload.lastErrors) ? payload.lastErrors : {}
  const statesError = isRecord(errors.opensky_states) ? String(errors.opensky_states.detail ?? '') : ''
  const rateLimited = statesError.includes('429')

  // A keyless community feed carrying the board is a working state, not a degraded one. Announcing
  // OpenSky's outage while the screen is visibly full of aircraft is what made this panel
  // untrustworthy, so an active fallback is reported ahead of the outage it covered for.
  const fallbackSource = typeof fallback.positionSource === 'string' ? fallback.positionSource : null
  const onFallback = fallback.activeRecently === true && fallbackSource !== null && fallbackSource !== 'opensky'

  let positions: ServiceStatus
  if (onFallback) {
    positions = {
      id: 'opensky',
      label: 'Flight positions',
      state: 'ok',
      detail: `Live via ${fallbackSource} — no key needed`,
      hint: opensky.configured ? undefined : 'Set opensky_client_id and opensky_client_secret to add route history',
    }
  } else if (!opensky.configured) {
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

  // Schedules no longer depend on a key at all, so this row reports what is actually available and
  // — when a metered key is in play — how much of today's allowance is left, since silently running
  // out of quota is what emptied these screens in the first place.
  const scheduleBudget = isRecord(fallback.scheduleBudget) ? fallback.scheduleBudget : {}
  const freeSchedules = Number(scheduleBudget.remaining ?? 0) > 0
  const airlabsRemaining = typeof airlabs.remaining === 'number' ? airlabs.remaining : null
  const airlabsSpent = airlabs.configured === true && airlabsRemaining === 0

  let schedules: ServiceStatus
  if (airlabsSpent) {
    schedules = {
      id: 'airlabs',
      label: 'Flight schedules',
      state: freeSchedules ? 'ok' : 'degraded',
      detail: freeSchedules ? 'Free source — AirLabs allowance spent for today' : 'No schedule source available right now',
      hint: 'The AirLabs daily allowance resets at UTC midnight; raise it with AIRLABS_DAILY_BUDGET',
    }
  } else if (airlabs.configured) {
    schedules = {
      id: 'airlabs',
      label: 'Flight schedules',
      state: 'ok',
      detail: airlabsRemaining !== null ? `Gates and delays · ${airlabsRemaining} AirLabs calls left today` : 'Gates, delays and schedules',
    }
  } else {
    schedules = {
      id: 'airlabs',
      label: 'Flight schedules',
      state: freeSchedules ? 'ok' : 'unconfigured',
      detail: freeSchedules ? 'Gates and delays from the free source' : 'Optional — no AirLabs key set',
      hint: 'Add airlabs_key to cross-check scheduled times against a second source',
    }
  }

  return [positions, schedules]
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
