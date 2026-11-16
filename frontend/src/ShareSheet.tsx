import { useEffect, useMemo, useRef, useState } from 'react'
import { Eye, EyeOff, QrCode, Settings, X } from 'lucide-react'
import { apiUrl } from './api'
import { qrMatrix, wifiQrPayload } from './qr'
import { SHARE_SHEET_SECONDS, withHomeAssistant } from './shareLinks'
import type { ShareLink } from './shareLinks'
import { useDialog } from './ui/useDialog'
import './ShareSheet.css'

interface WifiDetails { ssid: string; password: string; security: 'WPA' | 'WEP' | 'nopass'; hidden: boolean }
type WifiState = { state: 'loading' } | { state: 'error' } | { state: 'unset' } | { state: 'ready'; wifi: WifiDetails }

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

function shortAddress(url: string) {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
}

function QrCard({ title, label, text, children }: { title: string; label: string; text: string; children?: React.ReactNode }) {
  const quiet = 4
  const matrix = useMemo(() => { try { return qrMatrix(text) } catch { return null } }, [text])
  return (
    <li className="share-card">
      {matrix ? (
        <svg className="share-qr" viewBox={`0 0 ${matrix.length + quiet * 2} ${matrix.length + quiet * 2}`} shapeRendering="crispEdges" role="img" aria-label={label}>
          <rect width="100%" height="100%" fill="#fff" />
          <path d={qrPath(matrix, quiet)} fill="#000" />
        </svg>
      ) : <div className="share-qr is-missing" role="img" aria-label={`${title} is too long for a QR code`}>Too long</div>}
      <strong>{title}</strong>
      {children}
    </li>
  )
}

/**
 * One button, every QR code: the Wi-Fi network and each saved link, each with its name, all at once.
 * The whole sheet closes itself after `SHARE_SHEET_SECONDS`, or when the area outside it is tapped.
 */
export function ShareSheet({ onClose, onOpenSettings }: { onClose: () => void; onOpenSettings: () => void }) {
  // The sheet's own countdown owns closing, so the dialog's idle timer is off.
  const ref = useDialog<HTMLElement>({ onClose, idleMs: null })
  const [wifi, setWifi] = useState<WifiState>({ state: 'loading' })
  const [saved, setSaved] = useState<ShareLink[] | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(SHARE_SHEET_SECONDS)
  const [reveal, setReveal] = useState(false)
  // The page re-renders constantly (live data); the timer must not restart each time.
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })

  useEffect(() => {
    const abort = new AbortController()
    const options = { cache: 'no-store' as const, signal: abort.signal }
    fetch(apiUrl('wifi'), options)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('Wi-Fi unavailable'))))
      .then((data: { configured: boolean } & Partial<WifiDetails>) => {
        setWifi(data.configured && data.ssid ? { state: 'ready', wifi: { ssid: data.ssid, password: data.password ?? '', security: data.security ?? 'WPA', hidden: Boolean(data.hidden) } } : { state: 'unset' })
      })
      .catch(() => { if (!abort.signal.aborted) setWifi({ state: 'error' }) })
    fetch(apiUrl('links'), options)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('Links unavailable'))))
      .then((data: { links?: ShareLink[] }) => setSaved(Array.isArray(data.links) ? data.links : []))
      .catch(() => { if (!abort.signal.aborted) setSaved([]) })
    return () => abort.abort()
  }, [])

  useEffect(() => {
    const started = Date.now()
    const tick = window.setInterval(() => setSecondsLeft(Math.max(0, SHARE_SHEET_SECONDS - Math.floor((Date.now() - started) / 1000))), 500)
    const timer = window.setTimeout(() => closeRef.current(), SHARE_SHEET_SECONDS * 1000)
    return () => { window.clearInterval(tick); window.clearTimeout(timer) }
  }, [])

  const links = useMemo(() => (saved === null ? null : withHomeAssistant(saved)), [saved])
  const loading = wifi.state === 'loading' || links === null

  return (
    <div className="detail-backdrop" role="presentation" onClick={onClose}>
      <section ref={ref} className="detail-sheet glass-strong share-sheet" role="dialog" aria-modal="true" aria-labelledby="share-title" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" aria-hidden="true" />
        <header>
          <span className="detail-icon"><QrCode size={24} aria-hidden="true" /></span>
          <div><p>Point a phone camera at a code</p><h2 id="share-title">Share</h2></div>
          <button type="button" className="sheet-close" data-autofocus onClick={onClose} title="Close" aria-label="Close share"><X size={20} aria-hidden="true" /></button>
        </header>

        {loading && <p className="share-note" role="status">Loading…</p>}
        {!loading && (
          <ul className="share-grid">
            {wifi.state === 'ready' && (
              <QrCard title="Wi-Fi" label={`QR code to join ${wifi.wifi.ssid}`} text={wifiQrPayload(wifi.wifi)}>
                <small className="share-line">{wifi.wifi.ssid}</small>
                {/* The QR code carries the password, so nobody needs to read it: it stays hidden unless
                    someone with a device that cannot scan asks for it. */}
                {wifi.wifi.security !== 'nopass' && (
                  <>
                    {reveal && <code className="share-password">{wifi.wifi.password}</code>}
                    <button type="button" className="share-reveal" aria-pressed={reveal} onClick={() => setReveal(!reveal)}>
                      {reveal ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                      {reveal ? 'Hide password' : 'Show password'}
                    </button>
                  </>
                )}
              </QrCard>
            )}
            {links?.map((link) => (
              <QrCard key={`${link.label}|${link.url}`} title={link.label} label={`QR code to open ${link.label}`} text={link.url}>
                <small className="share-line">{shortAddress(link.url)}</small>
              </QrCard>
            ))}
          </ul>
        )}
        {!loading && wifi.state === 'error' && <p className="share-note" role="alert">Could not load the Wi-Fi details.</p>}
        {!loading && wifi.state === 'unset' && <p className="share-note">No Wi-Fi network has been added yet.</p>}

        <footer className="share-footer">
          <span className="share-countdown" role="timer" aria-live="off">Closes in {secondsLeft}s</span>
          <button type="button" className="detail-action" onClick={onOpenSettings}><Settings size={16} aria-hidden="true" /><span>Edit in Settings</span></button>
          <button type="button" className="detail-action" onClick={onClose}>Done</button>
          <i className="share-bar" style={{ animationDuration: `${SHARE_SHEET_SECONDS}s` }} aria-hidden="true" />
        </footer>
      </section>
    </div>
  )
}
