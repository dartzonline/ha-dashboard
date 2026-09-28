import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearCachedJson } from './cachedFetch'
import { useInsights } from './useInsights'

function history(values: number[]) {
  return values.map((value, index) => ({ state: String(value), last_changed: new Date(Date.UTC(2026, 7, 1, index)).toISOString() }))
}

afterEach(() => {
  clearCachedJson()
  vi.unstubAllGlobals()
})

describe('useInsights', () => {
  it('converts the gateway rates to Mbps and leaves other series alone', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('cbr750_gateway_download_speed') ? history([1000]) : history([72])
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
    }))
    const { result } = renderHook(() => useInsights(true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.series.get('sensor.cbr750_gateway_download_speed')?.[0].value).toBeCloseTo(8.192)
    expect(result.current.series.get('sensor.main_floor_temperature')?.[0].value).toBe(72)
    expect(result.current.error).toBeNull()
  })

  it('does not cache a failed series: it is reported and retried on the next mount', async () => {
    let salt503 = true
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('salt_level_percent') && salt503) {
        return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ detail: 'busy' }) } as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(history([5])) } as Response)
    })
    vi.stubGlobal('fetch', fetchMock)

    const first = renderHook(() => useInsights(true))
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    expect(first.result.current.error).toBe('1 of 13 histories unavailable')
    expect(first.result.current.series.get('sensor.esphome_web_79cc76_salt_level_percent')).toEqual([])
    first.unmount()

    salt503 = false
    const saltFetches = () => fetchMock.mock.calls.filter((call) => String(call[0]).includes('salt_level_percent')).length
    expect(saltFetches()).toBe(1)
    const second = renderHook(() => useInsights(true))
    await waitFor(() => expect(second.result.current.error).toBeNull())
    // Only the failed series was refetched; the twelve good ones came from the cache.
    expect(saltFetches()).toBe(2)
    expect(fetchMock.mock.calls.length).toBe(14)
  })

  it('does nothing until enabled', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useInsights(false))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(true)
  })
})
