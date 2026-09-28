import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeStates, nextEventId, useHomeAssistant } from './useHomeAssistant'
import type { HAEntity } from './types'

/** Stand-in for the browser socket that the test drives by hand. */
class MockSocket {
  static instances: MockSocket[] = []
  static OPEN = 1
  static CLOSED = 3
  url: string
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockSocket.instances.push(this)
  }

  open() {
    this.readyState = MockSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  frame(payload: unknown) {
    this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) } as MessageEvent)
  }

  /** Server-side drop: the browser fires close and the hook must recover. */
  drop() {
    this.readyState = MockSocket.CLOSED
    this.onclose?.(new Event('close'))
  }

  /** What the hook calls; mirrors `drop` so the effect cleanup and heartbeat paths behave like a browser. */
  close() {
    this.drop()
  }

  static latest() {
    return MockSocket.instances[MockSocket.instances.length - 1]
  }
}

function entity(entityId: string, state: string, lastUpdated: string): HAEntity {
  return { entity_id: entityId, state, attributes: {}, last_changed: lastUpdated, last_updated: lastUpdated }
}

const HEALTH = { status: 'ok', home_assistant: { configured: true, connected: true } }

function mockApi(states: () => HAEntity[]) {
  const calls = { states: 0, health: 0 }
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/states')) {
      calls.states += 1
      return Promise.resolve({ ok: true, json: () => Promise.resolve(states()) } as Response)
    }
    if (url.includes('/api/health')) {
      calls.health += 1
      return Promise.resolve({ ok: true, json: () => Promise.resolve(HEALTH) } as Response)
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

beforeEach(() => {
  MockSocket.instances = []
  vi.stubGlobal('WebSocket', MockSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useHomeAssistant', () => {
  it('loads states once at boot and goes live when the socket opens', async () => {
    const calls = mockApi(() => [entity('light.a', 'on', '2026-08-01T00:00:00Z')])
    const { result } = renderHook(() => useHomeAssistant())

    expect(result.current.connection).toBe('connecting')
    await waitFor(() => expect(result.current.entities.get('light.a')?.state).toBe('on'))
    expect(calls.states).toBe(1)
    expect(result.current.loading).toBe(false)

    act(() => MockSocket.latest().open())
    expect(result.current.connection).toBe('live')
    expect(result.current.lastMessageAt).toBeTypeOf('number')
  })

  it('refetches states after the socket drops and reopens', async () => {
    vi.useFakeTimers()
    const calls = mockApi(() => [])
    const { result } = renderHook(() => useHomeAssistant())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(calls.states).toBe(1)

    act(() => MockSocket.latest().open())
    act(() => MockSocket.latest().drop())
    expect(result.current.connection).toBe('reconnecting')

    // Past the stale threshold the header should say so; past the backoff a new socket appears.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100) })
    expect(result.current.connection).toBe('stale')
    expect(MockSocket.instances).toHaveLength(2)

    await act(async () => { MockSocket.latest().open() })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(calls.states).toBe(2)
    expect(result.current.connection).toBe('live')
  })

  it('does not refetch on the very first open, only on reconnects', async () => {
    vi.useFakeTimers()
    const calls = mockApi(() => [])
    renderHook(() => useHomeAssistant())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    act(() => MockSocket.latest().open())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(calls.states).toBe(1)
  })

  it('refetches states on a resync frame', async () => {
    const calls = mockApi(() => [])
    renderHook(() => useHomeAssistant())
    await waitFor(() => expect(calls.states).toBe(1))

    act(() => MockSocket.latest().open())
    act(() => MockSocket.latest().frame({ type: 'resync' }))
    await waitFor(() => expect(calls.states).toBe(2))
  })

  it('reads bridge frames, ignores ready frames and survives malformed JSON', async () => {
    mockApi(() => [])
    const { result } = renderHook(() => useHomeAssistant())
    act(() => MockSocket.latest().open())

    act(() => MockSocket.latest().frame({ type: 'ready' }))
    act(() => MockSocket.latest().frame('{not json'))
    expect(result.current.bridgeConnected).toBeNull()

    act(() => MockSocket.latest().frame({ type: 'bridge', connected: false }))
    expect(result.current.bridgeConnected).toBe(false)
    expect(result.current.connection).toBe('stale')

    act(() => MockSocket.latest().frame({ type: 'bridge', connected: true }))
    expect(result.current.bridgeConnected).toBe(true)
    expect(result.current.connection).toBe('live')
  })

  it('applies state_changed frames and reports the change with unique ids in one burst', async () => {
    mockApi(() => [])
    const changes: number[] = []
    const { result } = renderHook(() => useHomeAssistant((change) => changes.push(change.id)))
    act(() => MockSocket.latest().open())

    act(() => {
      for (let index = 0; index < 5; index += 1) {
        MockSocket.latest().frame({
          type: 'event',
          event: { data: { old_state: { state: 'off' }, new_state: entity(`light.${index}`, 'on', '2026-08-01T00:00:01Z') } },
        })
      }
    })
    expect(result.current.entities.size).toBe(5)
    expect(new Set(changes).size).toBe(5)
    // Strictly increasing, so a log sorted by id is a log sorted by arrival.
    expect([...changes].sort((a, b) => a - b)).toEqual(changes)
  })

  it('keeps a WS update that landed while the states fetch was in flight', async () => {
    let releaseStates: (value: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/states')) return new Promise<Response>((resolve) => { releaseStates = resolve })
      return Promise.resolve({ ok: true, json: () => Promise.resolve(HEALTH) } as Response)
    }))
    const { result } = renderHook(() => useHomeAssistant())
    act(() => MockSocket.latest().open())

    const later = new Date(Date.now() + 60_000).toISOString()
    act(() => MockSocket.latest().frame({ data: { new_state: entity('lock.front', 'unlocked', later) } }))

    const earlier = new Date(Date.now() - 60_000).toISOString()
    await act(async () => {
      releaseStates({ ok: true, json: () => Promise.resolve([entity('lock.front', 'locked', earlier), entity('light.b', 'off', earlier)]) } as Response)
    })
    await waitFor(() => expect(result.current.entities.get('light.b')).toBeTruthy())
    expect(result.current.entities.get('lock.front')?.state).toBe('unlocked')
  })

  it('retries a failed states load with backoff and clears the error once it succeeds', async () => {
    vi.useFakeTimers()
    let fail = true
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/states')) {
        return fail
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(HEALTH) } as Response)
    }))
    const { result } = renderHook(() => useHomeAssistant())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.error).toBe('Failed to fetch')
    expect(result.current.loading).toBe(false)

    fail = false
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100) })
    expect(result.current.error).toBeNull()
  })

  it('forces a reconnect when the bridge is up but the socket has gone silent', async () => {
    vi.useFakeTimers()
    mockApi(() => [])
    renderHook(() => useHomeAssistant())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    act(() => MockSocket.latest().open())
    expect(MockSocket.instances).toHaveLength(1)

    // Two minutes of silence while /api/health says connected: the next 15 s heartbeat check closes
    // the socket itself (at 135 s) and the reconnect backoff opens a replacement a few seconds later.
    await act(async () => { await vi.advanceTimersByTimeAsync(150_000) })
    expect(MockSocket.instances.length).toBeGreaterThanOrEqual(2)
  })

  it('closes the socket on unmount without scheduling a reconnect', async () => {
    vi.useFakeTimers()
    mockApi(() => [])
    const { unmount } = renderHook(() => useHomeAssistant())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    act(() => MockSocket.latest().open())
    unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(MockSocket.instances).toHaveLength(1)
  })
})

describe('mergeStates', () => {
  it('prefers whichever copy was updated more recently', () => {
    const current = new Map([['a', entity('a', 'live', '2026-08-01T00:00:10Z')], ['b', entity('b', 'old', '2026-08-01T00:00:00Z')]])
    const fetched = [entity('a', 'snapshot', '2026-08-01T00:00:05Z'), entity('b', 'snapshot', '2026-08-01T00:00:05Z')]
    const merged = mergeStates(current, fetched, Date.parse('2026-08-01T00:00:04Z'))
    expect(merged.get('a')?.state).toBe('live')
    expect(merged.get('b')?.state).toBe('snapshot')
  })

  it('drops entities the snapshot no longer has unless they appeared after the fetch began', () => {
    const fetchStart = Date.parse('2026-08-01T00:00:00Z')
    const current = new Map([
      ['gone', entity('gone', 'on', '2026-07-31T00:00:00Z')],
      ['brand_new', entity('brand_new', 'on', '2026-08-01T00:00:02Z')],
    ])
    const merged = mergeStates(current, [], fetchStart)
    expect(merged.has('gone')).toBe(false)
    expect(merged.has('brand_new')).toBe(true)
  })
})

describe('nextEventId', () => {
  it('is unique and increasing across a same-millisecond burst', () => {
    const ids = Array.from({ length: 1000 }, () => nextEventId())
    expect(new Set(ids).size).toBe(1000)
    expect(ids.every((id, index) => index === 0 || id > ids[index - 1])).toBe(true)
  })
})
