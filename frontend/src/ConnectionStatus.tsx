import { AlertTriangle, Check, CircleSlash, Minus, RefreshCw, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HAEntity, HealthResponse } from './types'
import type { ConnectionState } from './useHomeAssistant'
import { useServiceStatus } from './useServiceStatus'
import type { ServiceState } from './useServiceStatus'
import { useDialog } from './ui/useDialog'
import './ConnectionStatus.css'

interface ConnectionStatusProps {
  health: HealthResponse | null
  entities: Map<string, HAEntity>
  /** The live socket's own word, which decides the chip before any service check does. */
  connection: ConnectionState
  /** Owned by the shell so the Back button and the rotation pause treat it like every other sheet. */
  open: boolean
  onOpenChange: (open: boolean) => void
}

type ChipTone = 'live' | 'degraded' | 'offline'

const STATE_LABEL: Record<ServiceState, string> = {
  ok: 'Connected',
  checking: 'Connecting',
  unconfigured: 'Limited',
  degraded: 'Degraded',
  down: 'Offline',
}

/**
 * One word and one colour for the chip. The socket wins: a stale feed is "Offline" whatever the
 * last service check said, because the tiles on screen may no longer be true.
 */
function chipState(connection: ConnectionState, overall: ServiceState): { tone: ChipTone; label: string } {
  if (connection === 'stale') return { tone: 'offline', label: 'Offline' }
  if (connection === 'reconnecting') return { tone: 'degraded', label: 'Reconnecting' }
  if (connection === 'connecting') return { tone: 'degraded', label: 'Connecting' }
  if (overall === 'down') return { tone: 'degraded', label: 'Partial' }
  if (overall === 'degraded' || overall === 'unconfigured') return { tone: 'degraded', label: 'Degraded' }
  return { tone: 'live', label: 'Live' }
}

function StateIcon({ state }: { state: ServiceState }) {
  if (state === 'ok') return <Check size={13} aria-hidden="true" />
  if (state === 'degraded') return <AlertTriangle size={13} aria-hidden="true" />
  if (state === 'down') return <X size={13} aria-hidden="true" />
  if (state === 'unconfigured') return <Minus size={13} aria-hidden="true" />
  return <CircleSlash size={13} aria-hidden="true" />
}

interface PanelProps {
  anchor: DOMRect | null
  services: ReturnType<typeof useServiceStatus>['services']
  checkedAt: Date | null
  onRefresh: () => void
  onClose: () => void
}

/**
 * Portalled to <body>: the shell makes `<main>` inert while a sheet is open, and this panel used to
 * live inside main's topbar -- it would have made itself inert. Positioned under the chip from the
 * chip's own rectangle.
 */
function ServicePanel({ anchor, services, checkedAt, onRefresh, onClose }: PanelProps) {
  const ref = useDialog<HTMLDivElement>({ onClose })
  const style = anchor
    ? { top: `${Math.round(anchor.bottom + 8)}px`, right: `${Math.max(8, Math.round(window.innerWidth - anchor.right))}px` }
    : undefined

  return createPortal(
    <div className="connection-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={ref}
        className="connection-panel glass-strong"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-title"
        style={style}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <strong id="connection-title">Services</strong>
          <div className="connection-panel-actions">
            <button type="button" onClick={onRefresh} title="Re-check every service" aria-label="Re-check every service">
              <RefreshCw size={16} aria-hidden="true" />
            </button>
            <button type="button" data-autofocus onClick={onClose} title="Close" aria-label="Close service status">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
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
    </div>,
    document.body,
  )
}

export function ConnectionStatus({ health, entities, connection, open, onOpenChange }: ConnectionStatusProps) {
  const { services, overall, checkedAt, refresh } = useServiceStatus(open, health, entities)
  const chipRef = useRef<HTMLButtonElement | null>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const chip = chipState(connection, overall)
  const problems = services.filter((service) => service.state !== 'ok' && service.state !== 'checking').length

  return (
    <div className="connection-wrap">
      <button
        ref={chipRef}
        type="button"
        className={`connection-chip is-${chip.tone}`}
        onClick={() => {
          // Measured on the tap that opens it, so the panel appears in place rather than jumping.
          if (!open) setAnchor(chipRef.current?.getBoundingClientRect() ?? null)
          onOpenChange(!open)
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Connection: ${chip.label}. Services ${STATE_LABEL[overall].toLowerCase()}. Show service details`}
        title={`${chip.label} — show the status of every connected service`}
      >
        <i className="connection-chip-dot" aria-hidden="true" />
        <span className="connection-chip-label">{chip.label}</span>
        {problems > 0 && <em aria-hidden="true">{problems}</em>}
      </button>

      {open && (
        <ServicePanel
          anchor={anchor}
          services={services}
          checkedAt={checkedAt}
          onRefresh={() => void refresh()}
          onClose={() => onOpenChange(false)}
        />
      )}
    </div>
  )
}
