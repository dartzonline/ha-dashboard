import { useEffect, useState } from 'react'
import { BellRing, Check, Send, Trash2 } from 'lucide-react'
import { apiUrl, responseError } from './api'
import './RemindersSettings.css'

export interface BinScheduleSettings {
  enabled: boolean
  trashWeekday: number
  recycling: 'biweekly' | 'weekly' | 'none'
  recyclingAnchorDate: string | null
  remindStart: string
  remindEnd: string
  intervalMinutes: number
}

export interface NotificationSettings {
  targets: string[]
  forecast: boolean
  houseWatch: boolean
  bins: boolean
  weekly: boolean
  quietStart: string
  quietEnd: string
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** "notify.mobile_app_pixel_8" reads as "Pixel 8". */
export function targetLabel(target: string) {
  const name = target.replace(/^notify\./, '').replace(/^mobile_app_/, '').replaceAll('_', ' ')
  return name.replace(/\b\w/g, (letter) => letter.toUpperCase()).replace(/\bIphone\b/g, 'iPhone').replace(/\bIpad\b/g, 'iPad')
}

/** "16:00" reads as "4 pm", "21:30" as "9:30 pm". */
export function clockLabel(value: string) {
  const [hours, minutes] = value.split(':').map(Number)
  const suffix = hours < 12 ? 'am' : 'pm'
  return `${hours % 12 || 12}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''} ${suffix}`
}

type Status = { tone: 'success' | 'error'; text: string } | null

/** Settings > Reminders: bin night and phone notifications. Saves on its own, apart from the tile editor. */
export function RemindersSettings() {
  const [bins, setBins] = useState<BinScheduleSettings | null>(null)
  const [notify, setNotify] = useState<NotificationSettings | null>(null)
  const [targets, setTargets] = useState<string[] | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const abort = new AbortController()
    fetch(apiUrl('config'), { signal: abort.signal })
      .then((response) => response.json())
      .then((data: { binSchedule: BinScheduleSettings; notifications: NotificationSettings }) => { setBins(data.binSchedule); setNotify(data.notifications) })
      .catch(() => { if (!abort.signal.aborted) setStatus({ tone: 'error', text: 'Could not load reminder settings.' }) })
    fetch(apiUrl('notifications/targets'), { signal: abort.signal })
      .then((response) => (response.ok ? response.json() : { targets: [] }))
      .then((data: { targets: string[] }) => setTargets(data.targets))
      .catch(() => { if (!abort.signal.aborted) setTargets([]) })
    return () => abort.abort()
  }, [])

  async function save() {
    if (!bins || !notify) return
    setBusy(true)
    setStatus(null)
    try {
      const response = await fetch(apiUrl('config'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ binSchedule: bins, notifications: notify }),
      })
      if (!response.ok) throw await responseError(response, 'Save failed')
      setStatus({ tone: 'success', text: 'Reminders saved.' })
    } catch (error) {
      setStatus({ tone: 'error', text: error instanceof Error ? error.message : 'Save failed' })
    } finally {
      setBusy(false)
    }
  }

  async function sendTest() {
    if (!notify) return
    setBusy(true)
    setStatus(null)
    try {
      const response = await fetch(apiUrl('notifications/test'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets: notify.targets }),
      })
      if (!response.ok) throw await responseError(response, 'Test failed')
      setStatus({ tone: 'success', text: 'Test sent. Check your phone.' })
    } catch (error) {
      setStatus({ tone: 'error', text: error instanceof Error ? error.message : 'Test failed' })
    } finally {
      setBusy(false)
    }
  }

  if (!bins || !notify) return <div className="reminders-settings" role="tabpanel" id="config-panel-reminders" aria-labelledby="config-tab-reminders">
    <p className="config-hint">{status?.text ?? 'Loading reminders…'}</p>
  </div>

  const toggleTarget = (target: string, on: boolean) => setNotify({ ...notify, targets: on ? [...notify.targets, target] : notify.targets.filter((item) => item !== target) })

  return <div className="reminders-settings" role="tabpanel" id="config-panel-reminders" aria-labelledby="config-tab-reminders">
    <fieldset>
      <legend><Trash2 size={16} aria-hidden="true" /> Bin night</legend>
      <label className="config-light-check">
        <input type="checkbox" checked={bins.enabled} onChange={(event) => setBins({ ...bins, enabled: event.target.checked })} />
        <span>Remind me to take the bins out</span>
      </label>
      <div className="reminders-grid">
        <label><span>Pickup day</span>
          <select value={bins.trashWeekday} onChange={(event) => setBins({ ...bins, trashWeekday: Number(event.target.value) })}>
            {WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
          </select>
        </label>
        <label><span>Recycling</span>
          <select value={bins.recycling} onChange={(event) => setBins({ ...bins, recycling: event.target.value as BinScheduleSettings['recycling'] })}>
            <option value="biweekly">Every other week</option>
            <option value="weekly">Every week</option>
            <option value="none">Not collected</option>
          </select>
        </label>
        {bins.recycling === 'biweekly' && <label><span>A recycling pickup date</span>
          <input type="date" value={bins.recyclingAnchorDate ?? ''} onChange={(event) => setBins({ ...bins, recyclingAnchorDate: event.target.value || null })} />
        </label>}
        <label><span>Remind from</span>
          <input type="time" value={bins.remindStart} onChange={(event) => setBins({ ...bins, remindStart: event.target.value })} />
        </label>
        <label><span>Until</span>
          <input type="time" value={bins.remindEnd} onChange={(event) => setBins({ ...bins, remindEnd: event.target.value })} />
        </label>
        <label><span>Every</span>
          <select value={bins.intervalMinutes} onChange={(event) => setBins({ ...bins, intervalMinutes: Number(event.target.value) })}>
            {[15, 30, 45, 60, 90, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes > 60 ? 's' : ''}`}</option>)}
          </select>
        </label>
      </div>
      <p className="config-hint">
        The evening before pickup, the dashboard reminds you from {clockLabel(bins.remindStart)} until {clockLabel(bins.remindEnd)}, and asks once more on pickup morning.
        Tap <strong>Bins are out</strong> to stop the reminders for that week.
      </p>
    </fieldset>

    <fieldset>
      <legend><BellRing size={16} aria-hidden="true" /> Phone notifications</legend>
      {targets === null ? <p className="config-hint">Looking for phones…</p>
        : targets.length === 0 ? <p className="config-hint">Home Assistant has no notify services yet. Install the Home Assistant app on a phone and it appears here.</p>
          : <div className="reminders-targets">
            {targets.map((target) => <label className="config-light-check" key={target}>
              <input type="checkbox" checked={notify.targets.includes(target)} onChange={(event) => toggleTarget(target, event.target.checked)} />
              <span>{targetLabel(target)}</span>
            </label>)}
          </div>}
      <div className="reminders-toggles">
        <label className="config-light-check"><input type="checkbox" checked={notify.bins} onChange={(event) => setNotify({ ...notify, bins: event.target.checked })} /><span>Bin night</span></label>
        <label className="config-light-check"><input type="checkbox" checked={notify.forecast} onChange={(event) => setNotify({ ...notify, forecast: event.target.checked })} /><span>Weather warnings</span></label>
        <label className="config-light-check"><input type="checkbox" checked={notify.houseWatch} onChange={(event) => setNotify({ ...notify, houseWatch: event.target.checked })} /><span>Critical house alerts</span></label>
        <label className="config-light-check"><input type="checkbox" checked={notify.weekly} onChange={(event) => setNotify({ ...notify, weekly: event.target.checked })} /><span>Weekly report (Sunday 7 pm)</span></label>
      </div>
      <div className="reminders-grid">
        <label><span>Quiet from</span><input type="time" value={notify.quietStart} onChange={(event) => setNotify({ ...notify, quietStart: event.target.value })} /></label>
        <label><span>Until</span><input type="time" value={notify.quietEnd} onChange={(event) => setNotify({ ...notify, quietEnd: event.target.value })} /></label>
      </div>
      <p className="config-hint">Quiet hours hold back everything except critical house alerts, such as the garage open after dark.</p>
    </fieldset>

    {status && <p className={status.tone === 'error' ? 'detail-error' : 'config-success'} role="status">{status.text}</p>}
    <div className="config-footer">
      <button type="button" className="detail-action" onClick={() => void sendTest()} disabled={busy || notify.targets.length === 0}>
        <Send size={16} aria-hidden="true" /><span>Send a test</span>
      </button>
      <button type="button" className="detail-action primary" onClick={() => void save()} disabled={busy}>
        <Check size={16} aria-hidden="true" /><span>Save reminders</span>
      </button>
    </div>
  </div>
}
