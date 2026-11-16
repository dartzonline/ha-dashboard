/**
 * A wall panel runs for weeks without anyone touching it, and a browser that stays open that long
 * slowly collects things it never lets go of (decoded images, painted layers, listeners). The cure
 * every kiosk uses is a refresh the household never notices: the page comes back on the same screen,
 * with the same theme, because the address and the saved settings carry everything that matters.
 */
export const REFRESH_HOUR = 4
/** The overnight refresh waits until the page has been up at least this long, so a panel that was
 *  just restarted is not refreshed again for nothing. */
export const REFRESH_AFTER_MS = 20 * 3600_000
/** If a refresh at the usual hour was put off (a sheet was open), this is the hard limit. */
export const REFRESH_MAX_AGE_MS = 36 * 3600_000
/** The script heap of a healthy panel sits well under 50 MB; this only trips on a real leak. */
export const HEAP_LIMIT_BYTES = 300 * 1024 * 1024

interface RefreshCheck {
  /** How long this page load has been up. */
  ageMs: number
  /** The browser's local hour, 0 to 23. */
  hour: number
  /** Script heap in bytes, where the browser reports it. */
  heapBytes?: number
  /** Nothing is open (no sheet, no menu, no search), so a refresh would not interrupt anyone. */
  idle: boolean
}

export function shouldRefresh({ ageMs, hour, heapBytes, idle }: RefreshCheck): boolean {
  if (!idle) return false
  if (heapBytes !== undefined && heapBytes > HEAP_LIMIT_BYTES) return true
  if (ageMs >= REFRESH_MAX_AGE_MS) return true
  return hour === REFRESH_HOUR && ageMs >= REFRESH_AFTER_MS
}

export function scriptHeapBytes(): number | undefined {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory
  return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : undefined
}
