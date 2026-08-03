import { AlertTriangle, Check, CircleSlash, Minus, RefreshCw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { HAEntity, HealthResponse } from './types'
import { useServiceStatus } from './useServiceStatus'
import type { ServiceState } from './useServiceStatus'
import './ConnectionStatus.css'

interface ConnectionStatusProps {
  health: HealthResponse | null
  entities: Map<string, HAEntity>
  /** Rotation pauses while the panel is open, same as every other thing you can open. */
  onOpen: () => void
}

const STATE_LABEL: Record<ServiceState, string> = {
  ok: 'Connected',
  checking: 'Connecting',
  unconfigured: 'Limited',
  degraded: 'Degraded',
  down: 'Offline',
}

function StateIcon({ state }: { state: ServiceState }) {
  if (state === 'ok') return <Check size={13} aria-hidden="true" />
  if (state === 'degraded') return <AlertTriangle size={13} aria-hidden="true" />
  if (state === 'down') return <X size={13} aria-hidden="true" />
  if (state === 'unconfigured') return <Minus size={13} aria-hidden="true" />
  return <CircleSlash size={13} aria-hidden="true" />
}

export function ConnectionStatus({ health, entities, onOpen }: ConnectionStatusProps) {
  const [open, setOpen] = useState(false)
  const { services, overall, checkedAt, refresh } = useServiceStatus(open, health, entities)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  // A wall panel gets tapped by people walking past: closing on Escape and on any outside tap
  // keeps a stray tap from leaving the panel parked open over the dashboard.
  useEffect(() => {
    if (!open) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    function onPointer(event: PointerEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
    }
  }, [open])

  const problems = services.filter((service) => service.state !== 'ok' && service.state !== 'checking').length

  return (
    <div className="connection-wrap" ref={wrapperRef}>
      <button
        className={`connection-chip is-${overall}`}
        onClick={() => {
          setOpen((current) => {
            if (!current) onOpen()
            return !current
          })
        }}
        aria-expanded={open}
        aria-label={`Connection status: ${STATE_LABEL[overall]}. Show service details`}
        title="Show the status of every connected service"
      >
        <i aria-hidden="true" />
        <span>{STATE_LABEL[overall]}</span>
        {problems > 0 && <em>{problems}</em>}
      </button>

      {open && (
        <div className="connection-panel" role="dialog" aria-label="Service status">
          <header>
            <strong>Services</strong>
            <button onClick={() => void refresh()} title="Re-check every service" aria-label="Re-check every service">
              <RefreshCw size={13} aria-hidden="true" />
            </button>
          </header>

          <ul>
            {services.map((service) => (
              <li key={service.id} className={`is-${service.state}`}>
                <span className="connection-dot" aria-hidden="true"><StateIcon state={service.state} /></span>
                <div>
                  <strong>{service.label}</strong>
                  <small>{service.detail}</small>
                  {service.hint && <em>{service.hint}</em>}
                </div>
              </li>
            ))}
          </ul>

          <footer>
            {checkedAt
              ? `Checked ${checkedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
              : 'Checking…'}
          </footer>
        </div>
      )}
    </div>
  )
}
