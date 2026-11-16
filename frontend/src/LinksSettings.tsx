import { useEffect, useState } from 'react'
import { Check, Plus, Trash2 } from 'lucide-react'
import { apiUrl, responseError } from './api'
import { isWebAddress } from './shareLinks'
import type { ShareLink } from './shareLinks'
import './LinksSettings.css'

const MAX_LINKS = 12
/** Names offered as one tap; the address is typed in, because only the household knows it. */
const SUGGESTIONS = ['Hubitat', 'Plex', 'Homebridge', 'Router', 'Printer']

/** Settings > Share: the named addresses the Share button turns into QR codes, below the Wi-Fi. */
export function LinksSettings() {
  const [rows, setRows] = useState<ShareLink[] | null>(null)
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const abort = new AbortController()
    fetch(apiUrl('links'), { cache: 'no-store', signal: abort.signal })
      .then((response) => response.json())
      .then((data: { links?: ShareLink[] }) => setRows(Array.isArray(data.links) ? data.links : []))
      .catch(() => { if (!abort.signal.aborted) { setRows([]); setStatus({ tone: 'error', text: 'Could not load the saved links.' }) } })
    return () => abort.abort()
  }, [])

  if (rows === null) return null
  const filled = rows.filter((row) => row.label.trim() || row.url.trim())
  const valid = filled.every((row) => row.label.trim() && isWebAddress(row.url))
  const unused = SUGGESTIONS.filter((name) => !rows.some((row) => row.label.trim().toLowerCase() === name.toLowerCase()))

  function update(index: number, patch: Partial<ShareLink>) {
    setRows((current) => (current ?? []).map((row, at) => (at === index ? { ...row, ...patch } : row)))
    setStatus(null)
  }

  async function save() {
    setBusy(true)
    setStatus(null)
    try {
      const response = await fetch(apiUrl('config'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quickLinks: filled.map((row) => ({ label: row.label.trim(), url: row.url.trim() })) }),
      })
      if (!response.ok) throw await responseError(response, 'Could not save the links')
      const data = await response.json() as { quickLinks?: ShareLink[] }
      setRows(data.quickLinks ?? [])
      setStatus({ tone: 'success', text: 'Saved. The Share button shows these as QR codes.' })
    } catch (error) {
      setStatus({ tone: 'error', text: error instanceof Error ? error.message : 'Could not save' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="links-settings" aria-label="Links">
      <h3>Links</h3>
      <p className="config-hint">
        Each link becomes a QR code on the Share button, with its name underneath. Home Assistant is always included. These
        addresses only open on phones that are on your home Wi-Fi.
      </p>
      <ul className="links-rows">
        {rows.map((row, index) => (
          <li key={index}>
            <input className="links-name" value={row.label} maxLength={40} placeholder="Name" aria-label={`Link ${index + 1} name`} onChange={(event) => update(index, { label: event.target.value })} />
            <input className="links-url" value={row.url} maxLength={300} placeholder="http://192.168.1.20:8080" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false}
              aria-label={`Link ${index + 1} address`} aria-invalid={row.url.trim() !== '' && !isWebAddress(row.url)} onChange={(event) => update(index, { url: event.target.value })} />
            <button type="button" className="glass-pill" aria-label={`Remove link ${index + 1}`} onClick={() => { setRows(rows.filter((_, at) => at !== index)); setStatus(null) }}><Trash2 size={16} aria-hidden="true" /></button>
          </li>
        ))}
      </ul>
      {rows.length < MAX_LINKS && (
        <div className="links-add">
          <button type="button" className="glass-pill" onClick={() => setRows([...rows, { label: '', url: '' }])}><Plus size={15} aria-hidden="true" />Add a link</button>
          {unused.map((name) => (
            <button key={name} type="button" className="glass-pill" onClick={() => setRows([...rows, { label: name, url: 'http://' }])}>{name}</button>
          ))}
        </div>
      )}
      {!valid && <p className="detail-error" role="status">Each link needs a name and an address that starts with http:// or https://</p>}
      {status && <p className={status.tone === 'error' ? 'detail-error' : 'config-success'} role="status">{status.text}</p>}
      <div className="config-footer">
        <button type="button" className="detail-action primary" disabled={!valid || busy} onClick={() => void save()}>
          <Check size={16} aria-hidden="true" /><span>Save links</span>
        </button>
      </div>
    </section>
  )
}
