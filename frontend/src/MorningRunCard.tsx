import { useEffect, useState } from 'react'
import { Car, CheckCircle2, CircleAlert, Home, ShieldCheck } from 'lucide-react'
import { apiUrl, responseError } from './api'
import type { MorningRunStatus } from './useMorningBrief'
import './MorningRunCard.css'

const POLL_MS = 60_000

/** The morning run, from the backend, which watches the garage. Polled each minute. */
export function useMorningRun(enabled = true) {
  const [status, setStatus] = useState<MorningRunStatus | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const abort = new AbortController()
    const load = () => fetch(apiUrl('morning-run'), { signal: abort.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: MorningRunStatus | null) => { if (data) setStatus(data) })
      .catch(() => undefined)
    void load()
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => { abort.abort(); window.clearInterval(timer) }
  }, [enabled, reloadKey])
  return { status, reload: () => setReloadKey((key) => key + 1) }
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export function MorningRunCard({ status, onChanged }: { status: MorningRunStatus | null; onChanged: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'working'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  if (!status?.phase) return null

  async function secure() {
    setPhase('working')
    try {
      const response = await fetch(apiUrl('actions/secure-house'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
      })
      if (!response.ok) throw await responseError(response, 'Could not secure the house')
      const result = await response.json() as { secured: string[]; failures: unknown[] }
      setMessage(`Secured ${result.secured.length} thing${result.secured.length === 1 ? '' : 's'}${result.failures.length ? `; ${result.failures.length} could not be reached` : ''}.`)
      onChanged()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not secure the house')
    } finally {
      setPhase('idle')
    }
  }

  if (status.phase === 'before') {
    const checks = status.checks ?? []
    const issues = checks.filter((check) => !check.ok)
    return <section className="run-card glass" aria-label="Morning run">
      <header><Car size={18} aria-hidden="true" /><strong>Morning run</strong><span>{issues.length ? `${issues.length} to check` : 'Ready to go'}</span></header>
      <ul>
        {checks.map((check) => <li key={check.id} className={check.ok ? 'is-ok' : 'is-issue'}>
          {check.ok ? <CheckCircle2 size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}{check.label}
        </li>)}
      </ul>
    </section>
  }

  if (status.phase === 'out') {
    const left = status.leftBehind ?? []
    return <section className={`run-card glass${left.length ? ' is-alert' : ''}`} aria-label="Morning run">
      <header>
        <Car size={18} aria-hidden="true" /><strong>Out since {status.departedAt ? clock(status.departedAt) : '—'}</strong>
        <span>{left.length ? `${left.length} left behind` : 'House is secure'}</span>
      </header>
      {left.length > 0 && <ul>{left.map((item) => <li key={item.entityId} className="is-issue"><CircleAlert size={15} aria-hidden="true" />{item.label}</li>)}</ul>}
      {status.vacuumStarted && <p className="run-note">The vacuum is cleaning while you’re out.</p>}
      {message && <p className="run-note" role="status">{message}</p>}
      {status.canSecure && (phase === 'confirm'
        ? <div className="run-actions">
          <span>Lock the house doors and switch off what was left on?</span>
          <button type="button" className="detail-action primary" onClick={() => void secure()}><ShieldCheck size={16} aria-hidden="true" />Secure</button>
          <button type="button" className="detail-action" onClick={() => setPhase('idle')}>Cancel</button>
        </div>
        : <button type="button" className="detail-action primary run-secure" disabled={phase === 'working'} onClick={() => setPhase('confirm')}>
          <ShieldCheck size={16} aria-hidden="true" />{phase === 'working' ? 'Securing…' : 'Secure the house'}
        </button>)}
    </section>
  }

  return <section className="run-card glass is-back" aria-label="Morning run">
    <header><Home size={18} aria-hidden="true" /><strong>Back at {status.returnedAt ? clock(status.returnedAt) : '—'}</strong>
      <span>Out {status.departedAt && status.returnedAt ? `${Math.round((new Date(status.returnedAt).getTime() - new Date(status.departedAt).getTime()) / 60_000)} min` : ''}</span></header>
  </section>
}
