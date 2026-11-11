import { useEffect, useMemo, useRef, useState } from 'react'
import { Wifi, X } from 'lucide-react'
import { apiUrl } from './api'
import { qrMatrix, wifiQrPayload } from './qr'
import { useDialog } from './ui/useDialog'
import './WifiSheet.css'

/** How long the sheet stays up. It is never extended: a password on a wall panel should not linger. */
export const WIFI_SHEET_SECONDS = 45

interface WifiDetails { ssid: string; password: string; security: 'WPA' | 'WEP' | 'nopass'; hidden: boolean }
type Loaded = { state: 'loading' } | { state: 'error' } | { state: 'unset' } | { state: 'ready'; wifi: WifiDetails }

/** The QR as one path: a horizontal run of dark modules is one rectangle. */
function qrPath(matrix: boolean[][], quiet: number): string {
  const parts: string[] = []
  matrix.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue
      let end = x
      while (end + 1 < row.length && row[end + 1]) end++
      parts.push(`M${x + quiet} ${y + quiet}h${end - x + 1}v1h-${end - x + 1}z`)
      x = end
    }
  })
  return parts.join('')
}

export function WifiSheet({ onClose, onOpenSettings }: { onClose: () => void; onOpenSettings: () => void }) {
  // The sheet's own countdown owns closing, so the dialog's idle timer is off.
  const ref = useDialog<HTMLElement>({ onClose, idleMs: null })
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [secondsLeft, setSecondsLeft] = useState(WIFI_SHEET_SECONDS)
  // The page re-renders constantly (live data); the timer must not restart each time.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const abort = new AbortController()
    fetch(apiUrl('wifi'), { cache: 'no-store', signal: abort.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('Wi-Fi unavailable'))))
      .then((data: { configured: boolean } & Partial<WifiDetails>) => {
        setLoaded(data.configured && data.ssid ? { state: 'ready', wifi: { ssid: data.ssid, password: data.password ?? '', security: data.security ?? 'WPA', hidden: Boolean(data.hidden) } } : { state: 'unset' })
      })
      .catch(() => { if (!abort.signal.aborted) setLoaded({ state: 'error' }) })
    return () => abort.abort()
  }, [])

  useEffect(() => {
    const started = Date.now()
    const tick = window.setInterval(() => setSecondsLeft(Math.max(0, WIFI_SHEET_SECONDS - Math.floor((Date.now() - started) / 1000))), 500)
    const timer = window.setTimeout(() => closeRef.current(), WIFI_SHEET_SECONDS * 1000)
    return () => { window.clearInterval(tick); window.clearTimeout(timer) }
  }, [])

  const matrix = useMemo(() => (loaded.state === 'ready' ? qrMatrix(wifiQrPayload(loaded.wifi)) : null), [loaded])
  const quiet = 4

  return (
    <div className="detail-backdrop" role="presentation" onClick={onClose}>
      <section ref={ref} className="detail-sheet glass-strong wifi-sheet" role="dialog" aria-modal="true" aria-labelledby="wifi-title" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" aria-hidden="true" />
        <header>
          <span className="detail-icon"><Wifi size={24} aria-hidden="true" /></span>
          <div><p>Guests</p><h2 id="wifi-title">Join the Wi-Fi</h2></div>
          <button type="button" className="sheet-close" data-autofocus onClick={onClose} title="Close" aria-label="Close Wi-Fi"><X size={20} aria-hidden="true" /></button>
        </header>

        {loaded.state === 'loading' && <p className="wifi-note" role="status">Loading…</p>}
        {loaded.state === 'error' && <p className="wifi-note" role="alert">Could not load the Wi-Fi details.</p>}
        {loaded.state === 'unset' && (
          <div className="wifi-empty">
            <p>No Wi-Fi network has been added yet.</p>
            <button type="button" className="detail-action primary" onClick={onOpenSettings}>Add it in Settings</button>
          </div>
        )}
        {loaded.state === 'ready' && matrix && (
          <div className="wifi-body">
            <svg className="wifi-qr" viewBox={`0 0 ${matrix.length + quiet * 2} ${matrix.length + quiet * 2}`} shapeRendering="crispEdges" role="img" aria-label={`QR code to join ${loaded.wifi.ssid}`}>
              <rect width="100%" height="100%" fill="#fff" />
              <path d={qrPath(matrix, quiet)} fill="#000" />
            </svg>
            <dl className="wifi-details">
              <dt>Network</dt><dd>{loaded.wifi.ssid}</dd>
              {loaded.wifi.security !== 'nopass' && <><dt>Password</dt><dd className="is-password">{loaded.wifi.password}</dd></>}
            </dl>
            <p className="wifi-hint">Point a phone camera at the code to join.</p>
          </div>
        )}

        <footer className="wifi-footer">
          <span className="wifi-countdown" role="timer" aria-live="off">Closes in {secondsLeft}s</span>
          <button type="button" className="detail-action" onClick={onClose}>Done</button>
          <i className="wifi-bar" style={{ animationDuration: `${WIFI_SHEET_SECONDS}s` }} aria-hidden="true" />
        </footer>
      </section>
    </div>
  )
}
