import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachedJson, clearCachedJson, invalidate, isAbortError, peekCached } from './cachedFetch'

afterEach(() => {
  clearCachedJson()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)
}

describe('cachedJson', () => {
  it('fetches once and serves later callers within the TTL', async () => {
    const fetchMock = vi.fn(() => okJson({ n: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await cachedJson('thing', 'thing', 60_000)).toEqual({ n: 1 })
    expect(await cachedJson('thing', 'thing', 60_000)).toEqual({ n: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/api/thing')
  })

  it('shares one in-flight request between concurrent callers', async () => {
    const fetchMock = vi.fn(() => okJson({ n: 2 }))
    vi.stubGlobal('fetch', fetchMock)

    const [a, b] = await Promise.all([cachedJson('shared', 'shared', 60_000), cachedJson('shared', 'shared', 60_000)])
    expect(a).toEqual({ n: 2 })
    expect(b).toEqual({ n: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refetches once the entry is older than the caller will accept', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(() => okJson({ n: 3 }))
    vi.stubGlobal('fetch', fetchMock)

    await cachedJson('aging', 'aging', 1_000)
    vi.advanceTimersByTime(1_500)
    // A patient caller still takes the old value; an impatient one refetches.
    await cachedJson('aging', 'aging', 10_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await cachedJson('aging', 'aging', 1_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not cache a non-OK response, and surfaces the backend detail', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({ detail: 'Recorder is busy' }) } as Response)
      .mockImplementation(() => okJson({ n: 4 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(cachedJson('flaky', 'flaky', 60_000)).rejects.toThrow('Recorder is busy')
    expect(peekCached('flaky')).toBeUndefined()
    // The very next read retries rather than serving an empty placeholder.
    expect(await cachedJson('flaky', 'flaky', 60_000)).toEqual({ n: 4 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not cache a rejected loader either', async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('later')
    await expect(cachedJson('loader', loader, 60_000)).rejects.toThrow('offline')
    expect(await cachedJson('loader', loader, 60_000)).toBe('later')
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('detaches an aborted caller without cancelling the shared request', async () => {
    let resolveFetch: (value: Response) => void = () => {}
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve }))
    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    const detached = cachedJson('slow', 'slow', 60_000, { signal: controller.signal })
    const patient = cachedJson('slow', 'slow', 60_000)
    controller.abort()
    await expect(detached).rejects.toSatisfy(isAbortError)

    resolveFetch({ ok: true, status: 200, json: () => Promise.resolve({ n: 5 }) } as Response)
    expect(await patient).toEqual({ n: 5 })
    expect(peekCached('slow')).toEqual({ n: 5 })
  })

  it('force refetches and replaces the cached value', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(() => okJson({ n: 1 })).mockImplementationOnce(() => okJson({ n: 2 }))
    vi.stubGlobal('fetch', fetchMock)

    await cachedJson('poll', 'poll', 60_000)
    expect(await cachedJson('poll', 'poll', 60_000, { force: true })).toEqual({ n: 2 })
    expect(peekCached('poll')).toEqual({ n: 2 })
  })

  it('invalidates one key or a whole prefix', async () => {
    vi.stubGlobal('fetch', vi.fn(() => okJson('x')))
    await cachedJson('history/a?hours=24', 'history/a?hours=24', 60_000)
    await cachedJson('history/b?hours=24', 'history/b?hours=24', 60_000)
    await cachedJson('config', 'config', 60_000)

    invalidate('config')
    expect(peekCached('config')).toBeUndefined()
    invalidate('history/', { prefix: true })
    expect(peekCached('history/a?hours=24')).toBeUndefined()
    expect(peekCached('history/b?hours=24')).toBeUndefined()
  })
})
