import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishTrack, resetFlightBoard, useFlightBoard } from './useFlightBoard'

const HOME = { latitude: 30.63, longitude: -97.68 }
const TRACK = { query: 'SWA771', mode: 'track', flight: null, route: null, schedule: {}, progress: 0, etaLine: null, flights: [] }
const NEARBY = { home: { lat: 30.63, lon: -97.68, rangeKm: 100 }, updatedAt: '', aircraft: [] }

function mockApi() {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.includes('flights/track') ? TRACK : url.includes('flights/nearby') ? NEARBY : null
    if (body === null) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response)
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function count(fetchMock: ReturnType<typeof mockApi>, needle: string) {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes(needle)).length
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  resetFlightBoard()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
})

describe('useFlightBoard', () => {
  it('polls track every 10 s and nearby every 30 s from one interval', async () => {
    const fetchMock = mockApi()
    const { result } = renderHook(() => useFlightBoard(HOME))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(count(fetchMock, 'flights/track')).toBe(1)
    expect(count(fetchMock, 'flights/nearby')).toBe(1)
    expect(result.current.track?.query).toBe('SWA771')
    expect(result.current.nearby?.home.rangeKm).toBe(100)

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(count(fetchMock, 'flights/track')).toBe(7)
    expect(count(fetchMock, 'flights/nearby')).toBe(3)
  })

  it('shares one poller between two subscribers and stops when the last one leaves', async () => {
    const fetchMock = mockApi()
    const first = renderHook(() => useFlightBoard(HOME))
    const second = renderHook(() => useFlightBoard(null))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(count(fetchMock, 'flights/track')).toBe(2)
    expect(second.result.current.track).toBe(first.result.current.track)

    first.unmount()
    second.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(count(fetchMock, 'flights/track')).toBe(2)
  })

  it('does not fetch nearby traffic until it knows where home is', async () => {
    const fetchMock = mockApi()
    const { rerender } = renderHook(({ home }) => useFlightBoard(home), { initialProps: { home: null as typeof HOME | null } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(count(fetchMock, 'flights/nearby')).toBe(0)

    // Coordinates arriving later (entities loaded) fetch straight away rather than at the next tick.
    rerender({ home: HOME })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(count(fetchMock, 'flights/nearby')).toBe(1)
  })

  it('pauses while the tab is hidden and refreshes the moment it is shown again', async () => {
    const fetchMock = mockApi()
    renderHook(() => useFlightBoard(HOME))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(count(fetchMock, 'flights/track')).toBe(1)

    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(count(fetchMock, 'flights/track')).toBe(2)
    expect(count(fetchMock, 'flights/nearby')).toBe(2)
  })

  it('keeps the last board and records the error when a poll fails', async () => {
    const fetchMock = mockApi()
    const { result } = renderHook(() => useFlightBoard(HOME))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) } as Response))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(result.current.track?.query).toBe('SWA771')
    expect(result.current.trackError).toBe('Track unavailable (502)')
  })

  it('puts a published board up immediately for every subscriber', async () => {
    mockApi()
    const { result } = renderHook(() => useFlightBoard(HOME))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    act(() => publishTrack({ ...TRACK, query: 'UAL455', mode: 'await' }))
    expect(result.current.track?.query).toBe('UAL455')
  })
})
