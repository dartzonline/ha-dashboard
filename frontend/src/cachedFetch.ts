import { apiUrl, responseError } from './api'

/**
 * One module-wide cache for every JSON the dashboard fetches more than once.
 *
 * Pages re-mount every rotation (~20 s) and detail sheets are opened repeatedly, so without this
 * each visit re-read the recorder. Entries are keyed by the caller (usually the relative API path,
 * so two views asking for the same history share one request) and judged fresh per call, so a
 * sparkline can accept a ten-minute-old payload that an energy view would refetch at thirty.
 *
 * Failures are never cached: a 5xx or an aborted fetch leaves the previous value in place (if any)
 * and the next caller retries. In-flight requests are shared, and a caller's `signal` only
 * detaches that caller -- it never cancels a request another view is still waiting on.
 */
interface CacheEntry {
  value: unknown
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<unknown>>()

export type JsonSource<T> = string | (() => Promise<T>)

export interface CachedJsonOptions {
  /** Detaches this caller when aborted; the shared request itself carries on for everyone else. */
  signal?: AbortSignal
  /** Refetch even if a fresh entry exists (a poll interval, or right after a mutation). */
  force?: boolean
}

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError')
}

/** Resolves/rejects with `promise`, or rejects early with AbortError when `signal` fires. */
function detachable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

async function loadJson<T>(source: JsonSource<T>): Promise<T> {
  if (typeof source !== 'string') return source()
  const response = await fetch(apiUrl(source))
  if (!response.ok) throw await responseError(response, 'Request failed')
  return response.json() as Promise<T>
}

export function isAbortError(error: unknown) {
  return Boolean(error) && typeof error === 'object' && (error as { name?: string }).name === 'AbortError'
}

/**
 * @param key      cache key; by convention the relative API path (`history/sensor.x?hours=24`)
 * @param source   that path (fetched with `apiUrl`) or a loader returning the parsed value
 * @param ttlMs    how old a cached value this caller will accept
 */
export function cachedJson<T>(key: string, source: JsonSource<T>, ttlMs: number, options: CachedJsonOptions = {}): Promise<T> {
  const cached = cache.get(key)
  if (!options.force && cached && Date.now() - cached.fetchedAt < ttlMs) {
    return detachable(Promise.resolve(cached.value as T), options.signal)
  }
  const pending = inflight.get(key)
  if (pending) return detachable(pending as Promise<T>, options.signal)

  const request = loadJson(source)
    .then((value) => {
      cache.set(key, { value, fetchedAt: Date.now() })
      return value
    })
    .finally(() => { inflight.delete(key) })
  inflight.set(key, request)
  // Callers may legitimately detach without ever observing the shared request's outcome.
  request.catch(() => undefined)
  return detachable(request, options.signal)
}

/** The cached value if one exists and is younger than `ttlMs` (any age when omitted). For state initialisers. */
export function peekCached<T>(key: string, ttlMs = Number.POSITIVE_INFINITY): T | undefined {
  const cached = cache.get(key)
  if (!cached || Date.now() - cached.fetchedAt >= ttlMs) return undefined
  return cached.value as T
}

/** Drops one key, or every key under a prefix when `{ prefix: true }`, so the next read refetches. */
export function invalidate(key: string, options: { prefix?: boolean } = {}) {
  if (!options.prefix) {
    cache.delete(key)
    return
  }
  for (const existing of cache.keys()) {
    if (existing.startsWith(key)) cache.delete(existing)
  }
}

/** Test hook: forgets everything, including in-flight bookkeeping. */
export function clearCachedJson() {
  cache.clear()
  inflight.clear()
}
