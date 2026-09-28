function relativeApiPath(path: string) {
  return `api/${path.replace(/^\/?api\/?/, '').replace(/^\//, '')}`
}

export function apiUrl(path: string) {
  return new URL(relativeApiPath(path), document.baseURI).toString()
}

export function webSocketUrl(path: string) {
  const url = new URL(relativeApiPath(path), document.baseURI)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/**
 * A signal that aborts after `ms`. A kiosk on flaky Wi-Fi can otherwise hold a fetch open for
 * minutes, during which nothing retries; aborting turns a hang into an ordinary error path.
 * `AbortSignal.timeout` is preferred and the manual controller only covers older runtimes.
 */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const controller = new AbortController()
  window.setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms)
  return controller.signal
}

/** The backend's `{"detail": "..."}` error body when there is one, else a status-based line. */
export async function responseError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => null)
  const detail = body && typeof body === 'object' && typeof (body as { detail?: unknown }).detail === 'string'
    ? (body as { detail: string }).detail
    : null
  return new Error(detail ?? `${fallback} (${response.status})`)
}
