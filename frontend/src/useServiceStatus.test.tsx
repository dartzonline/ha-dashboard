import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HAEntity } from './types'
import { homeCoordinates, useServiceStatus, worstState } from './useServiceStatus'

function zone(latitude: number, longitude: number): Map<string, HAEntity> {
  return new Map([[
    'zone.home',
    { entity_id: 'zone.home', state: 'zoning', attributes: { latitude, longitude }, last_changed: '', last_updated: '' },
  ]])
}

const HEALTH = { status: 'ok', home_assistant: { configured: true, connected: true } }

afterEach(() => vi.unstubAllGlobals())

describe('useServiceStatus', () => {
  it('probes once per open, not once per entities tick', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('flights/status') ? { opensky: { configured: true, tokenOk: true, statesOk: true }, airlabs: {}, fallback: {}, lastErrors: {} } : {}
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result, rerender } = renderHook(
      ({ entities }) => useServiceStatus(true, HEALTH, entities),
      { initialProps: { entities: zone(30.63, -97.68) } },
    )
    await waitFor(() => expect(result.current.checkedAt).not.toBeNull())
    const callsAfterFirstProbe = fetchMock.mock.calls.length
    expect(callsAfterFirstProbe).toBe(3)

    // A new Map with the same coordinates is what every WebSocket frame produces.
    rerender({ entities: zone(30.63, -97.68) })
    rerender({ entities: zone(30.63, -97.68) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstProbe)

    // Actually moving house does re-probe.
    rerender({ entities: zone(51.5, -0.12) })
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(callsAfterFirstProbe + 3))
  })

  it('does nothing while the panel is closed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useServiceStatus(false, HEALTH, zone(1, 2)))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.services.map((service) => service.id)).toEqual(['ha'])
    expect(result.current.overall).toBe('ok')
  })

  it('names the bridge state from health', () => {
    const { result } = renderHook(() => useServiceStatus(false, { status: 'degraded', home_assistant: { configured: true, connected: false } }, new Map()))
    expect(result.current.services[0]).toMatchObject({ id: 'ha', state: 'down' })
    expect(result.current.overall).toBe('down')
  })
})

describe('homeCoordinates', () => {
  it('skips candidates that exist but publish no coordinates', () => {
    const entities = new Map<string, HAEntity>([
      ['weather.forecast_home', { entity_id: 'weather.forecast_home', state: 'sunny', attributes: {}, last_changed: '', last_updated: '' }],
      ...zone(30.63, -97.68),
    ])
    expect(homeCoordinates(entities)).toEqual({ latitude: 30.63, longitude: -97.68 })
    expect(homeCoordinates(new Map())).toBeNull()
  })
})

describe('worstState', () => {
  it('lets the worst row speak for the list', () => {
    expect(worstState([{ id: 'a', label: 'A', state: 'ok', detail: '' }, { id: 'b', label: 'B', state: 'degraded', detail: '' }])).toBe('degraded')
    expect(worstState([])).toBe('ok')
  })
})
