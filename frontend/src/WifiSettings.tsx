import { useEffect, useMemo, useState } from 'react'
import { Check, Eye, EyeOff, Wifi } from 'lucide-react'
import { apiUrl, responseError } from './api'
import type { HAEntity } from './types'
import './WifiSettings.css'

interface GuestWifiSummary { ssid: string; security: 'WPA' | 'WEP' | 'nopass'; hidden: boolean; hasPassword: boolean }

/** Network names Home Assistant's own devices report being connected to, so the name is one tap, not typing. */
export function detectedNetworks(entities: Map<string, HAEntity>): string[] {
  const found = new Set<string>()
  for (const entity of entities.values()) {
    if (!/_ssid(_\d+)?$/.test(entity.entity_id) || !entity.entity_id.startsWith('sensor.')) continue
    const state = entity.state.trim()
    if (state && !['unavailable', 'unknown', 'none'].includes(state.toLowerCase())) found.add(state)
  }
  return [...found].slice(0, 4)
}

/** Settings > Wi-Fi: the network the Share Wi-Fi button shows as a QR code. Saves on its own. */
export function WifiSettings({ entities }: { entities: Map<string, HAEntity> }) {
  const [saved, setSaved] = useState<GuestWifiSummary | null | undefined>(undefined)
  const [ssid, setSsid] = useState('')
  const [security, setSecurity] = useState<GuestWifiSummary['security']>('WPA')
  const [hidden, setHidden] = useState(false)
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const suggestions = useMemo(() => detectedNetworks(entities), [entities])

  useEffect(() => {
    const abort = new AbortController()
    fetch(apiUrl('config'), { signal: abort.signal })
      .then((response) => response.json())
      .then((data: { guestWifi: GuestWifiSummary | null }) => {
        setSaved(data.guestWifi)
        if (data.guestWifi) { setSsid(data.guestWifi.ssid); setSecurity(data.guestWifi.security); setHidden(data.guestWifi.hidden) }
      })
      .catch(() => { if (!abort.signal.aborted) { setSaved(null); setStatus({ tone: 'error', text: 'Could not load the saved Wi-Fi.' }) } })
    return () => abort.abort()
  }, [])

  const needsPassword = security !== 'nopass'
  const passwordOk = !needsPassword || password.length >= (security === 'WPA' ? 8 : 5) || (saved?.hasPassword === true && password === '')
  const canSave = ssid.trim().length > 0 && ssid.length <= 32 && passwordOk && !busy

  async function save() {
    setBusy(true)
    setStatus(null)
    try {
      const response = await fetch(apiUrl('config'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestWifi: { ssid: ssid.trim(), security, hidden, ...(needsPassword && password ? { password } : {}) } }),
      })
      if (!response.ok) throw await responseError(response, 'Could not save')
      const data = await response.json() as { guestWifi: GuestWifiSummary | null }
      setSaved(data.guestWifi)
      setPassword('')
      setStatus({ tone: 'success', text: 'Saved. The Share Wi-Fi button now shows this network.' })
    } catch (error) {
      setStatus({ tone: 'error', text: error instanceof Error ? error.message : 'Could not save' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wifi-settings" role="tabpanel" id="config-panel-wifi" aria-labelledby="config-tab-wifi">
      <p className="config-hint">
        The <strong>Wi-Fi</strong> button at the top of the screen shows this network as a QR code for 45 seconds, so guests can join
        without typing. The password is kept on the add-on and only sent to the screen when the button is pressed.
      </p>
      {suggestions.length > 0 && !ssid && (
        <div className="wifi-suggestions">
          <span>Your devices are on:</span>
          {suggestions.map((name) => <button key={name} type="button" className="glass-pill" onClick={() => setSsid(name)}>{name}</button>)}
        </div>
      )}
      <label className="wifi-field"><span>Network name</span>
        <input value={ssid} maxLength={32} autoComplete="off" onChange={(event) => setSsid(event.target.value)} aria-label="Wi-Fi network name" />
      </label>
      <label className="wifi-field"><span>Security</span>
        <select value={security} onChange={(event) => setSecurity(event.target.value as GuestWifiSummary['security'])}>
          <option value="WPA">WPA / WPA2 / WPA3</option>
          <option value="WEP">WEP</option>
          <option value="nopass">Open (no password)</option>
        </select>
      </label>
      {needsPassword && (
        <label className="wifi-field"><span>Password{saved?.hasPassword ? ' (leave empty to keep the saved one)' : ''}</span>
          <span className="wifi-password">
            <input
              type={reveal ? 'text' : 'password'} value={password} maxLength={63} autoComplete="new-password"
              placeholder={saved?.hasPassword ? '••••••••' : ''} onChange={(event) => setPassword(event.target.value)} aria-label="Wi-Fi password"
            />
            <button type="button" className="glass-pill" onClick={() => setReveal(!reveal)} aria-label={reveal ? 'Hide password' : 'Show password'}>
              {reveal ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
            </button>
          </span>
        </label>
      )}
      <label className="config-light-check"><input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} /><span>Hidden network</span></label>
      {status && <p className={status.tone === 'error' ? 'detail-error' : 'config-success'} role="status">{status.text}</p>}
      <div className="config-footer">
        <button type="button" className="detail-action primary" disabled={!canSave} onClick={() => void save()}>
          <Check size={16} aria-hidden="true" /><span>Save Wi-Fi</span>
        </button>
      </div>
      {saved && <p className="wifi-saved"><Wifi size={14} aria-hidden="true" />Showing “{saved.ssid}”</p>}
    </div>
  )
}
