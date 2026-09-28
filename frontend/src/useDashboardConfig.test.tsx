import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDashboardConfig } from './useDashboardConfig'

const CONFIG = { sections: null, nightModeIndoorLights: ['light.a'], energyRatePerKwh: 0.2, ignoredEntityIds: [] }

function mockConfig(put: (body: unknown) => Promise<Response>, get: () => Promise<Response> = () => Promise.resolve({ ok: true, json: () => Promise.resolve(CONFIG) } as Response)) {
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'PUT' ? put(init.body) : get()))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useDashboardConfig', () => {
  it('becomes ready once the stored configuration has loaded', async () => {
    mockConfig(() => Promise.reject(new Error('unused')))
    const { result } = renderHook(() => useDashboardConfig())
    expect(result.current.ready).toBe(false)
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.energyRatePerKwh).toBe(0.2)
    expect(result.current.nightModeIndoorLights).toEqual(['light.a'])
    expect(result.current.error).toBeNull()
  })

  it('rolls the energy rate back when the save is refused', async () => {
    mockConfig(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ detail: 'disk full' }) } as Response))
    const { result } = renderHook(() => useDashboardConfig())
    await waitFor(() => expect(result.current.ready).toBe(true))

    let failure: unknown
    await act(async () => {
      await result.current.saveEnergyRate(0.31).catch((error: unknown) => { failure = error })
    })
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('disk full')
    expect(result.current.energyRatePerKwh).toBe(0.2)
  })

  it('keeps the new rate, as the server echoed it, when the save succeeds', async () => {
    mockConfig(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ...CONFIG, energyRatePerKwh: 0.31 }) } as Response))
    const { result } = renderHook(() => useDashboardConfig())
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => { await result.current.saveEnergyRate(0.31) })
    expect(result.current.energyRatePerKwh).toBe(0.31)
  })

  it('exposes the load error, stays not-ready, and retries until the backend answers', async () => {
    vi.useFakeTimers()
    let attempts = 0
    mockConfig(
      () => Promise.reject(new Error('unused')),
      () => {
        attempts += 1
        return attempts < 3
          ? Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ detail: 'starting up' }) } as Response)
          : Promise.resolve({ ok: true, json: () => Promise.resolve(CONFIG) } as Response)
      },
    )
    const { result } = renderHook(() => useDashboardConfig())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.error).toBe('starting up')
    expect(result.current.loading).toBe(false)
    expect(result.current.ready).toBe(false)

    // 3 s then 6 s of backoff.
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100) })
    expect(attempts).toBe(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(6_100) })
    expect(attempts).toBe(3)
    expect(result.current.ready).toBe(true)
    expect(result.current.error).toBeNull()
  })
})
