import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle, BatteryLow, CheckCircle2, DoorOpen, HardDriveDownload,
  RefreshCw, ShieldAlert, Trash2, Wrench,
} from 'lucide-react'
import { apiUrl } from './api'
import type { TileConfig } from './types'
import './HealthView.css'

interface AttentionItem {
  severity: 'critical' | 'warning' | 'info'
  category: string
  title: string
  detail: string
  entityId: string | null
}

interface Registry {
  total: number
  live: number
  unavailable: number
  duplicates: { entityId: string; name: string; replacedBy: string }[]
  orphans: { entityId: string; name: string }[]
  orphanCount: number
}

interface HealthPayload {
  items: AttentionItem[]
  counts: { critical: number; warning: number; info: number }
  registry: Registry
}

interface HealthViewProps {
  onExpand: (tile: TileConfig) => void
}

/** One glyph per category so the list scans without reading every line. */
const CATEGORY_ICON: Record<string, typeof AlertTriangle> = {
  backup: HardDriveDownload,
  battery: BatteryLow,
  consumable: Wrench,
  problem: AlertTriangle,
  safety: ShieldAlert,
  opening: DoorOpen,
  stale: RefreshCw,
  update: RefreshCw,
}

const CATEGORY_LABEL: Record<string, string> = {
  backup: 'Backup',
  battery: 'Battery',
  consumable: 'Consumable',
  problem: 'Problem',
  safety: 'Safety',
  opening: 'Left open',
  stale: 'Stale sensor',
  update: 'Update',
}

export function HealthView({ onExpand }: HealthViewProps) {
  const [payload, setPayload] = useState<HealthPayload | null>(null)
  const [failed, setFailed] = useState(false)
  const [showCleanup, setShowCleanup] = useState(false)

  const load = useCallback((signal?: AbortSignal) => {
    fetch(apiUrl('insights/health'), { signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('unavailable'))))
      .then((data: HealthPayload) => { setPayload(data); setFailed(false) })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name === 'AbortError') return
        setFailed(true)
      })
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    load(abort.signal)
    // Slow poll: this is state that changes on the order of hours, and the
    // endpoint reads every entity in the house.
    const timer = window.setInterval(() => load(), 300_000)
    return () => { abort.abort(); window.clearInterval(timer) }
  }, [load])

  const counts = payload?.counts
  const registry = payload?.registry
  const clear = payload !== null && payload.items.length === 0

  return (
    <section className="health-view" aria-label="Home health">
      <header>
        <div>
          {clear ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          <h2>{clear ? 'Nothing needs attention' : 'Needs attention'}</h2>
        </div>
        <span>
          {failed ? 'Health check unavailable'
            : counts ? `${counts.critical} critical · ${counts.warning} warning · ${counts.info} info`
            : 'Checking…'}
        </span>
      </header>

      {payload && payload.items.length > 0 && (
        <ul className="health-list">
          {payload.items.map((item) => {
            const Icon = CATEGORY_ICON[item.category] ?? AlertTriangle
            const clickable = Boolean(item.entityId)
            return (
              <li key={`${item.category}-${item.title}-${item.entityId ?? ''}`} className={`tone-${item.severity}`}>
                <button
                  type="button"
                  disabled={!clickable}
                  onClick={clickable
                    ? () => onExpand({ entityId: item.entityId as string, label: item.title, kind: 'sensor', icon: 'wrench' })
                    : undefined}
                  title={clickable ? `Open ${item.title}` : item.title}
                >
                  <Icon size={15} />
                  <span className="health-title">{item.title}</span>
                  <em>{item.detail}</em>
                  <small>{CATEGORY_LABEL[item.category] ?? item.category}</small>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {clear && (
        <p className="health-clear">
          <CheckCircle2 size={15} />
          No failing backups, low batteries, spent consumables, active problems or frozen sensors.
        </p>
      )}

      {registry && (
        <div className="health-registry">
          <div className="health-registry-head">
            <Trash2 size={15} />
            <h3>Entity registry</h3>
            <span>{registry.live} live of {registry.total}</span>
          </div>

          <div className="health-registry-figures">
            <div>
              <strong>{registry.unavailable}</strong>
              <small>Unavailable</small>
            </div>
            <div>
              <strong>{registry.duplicates.length}</strong>
              <small>Stale duplicates</small>
            </div>
            <div>
              <strong>{registry.orphanCount}</strong>
              <small>No live twin</small>
            </div>
          </div>

          <p className="health-registry-note">
            {/* The distinction is the whole point: a duplicate is provably safe to
                delete because something live replaced it. An orphan might be real
                broken hardware, or just a device that is asleep. */}
            Duplicates are left behind when a device is re-paired — each one has a working
            replacement listed beside it, so it is safe to delete in Home Assistant. Entities with
            no live twin could be genuinely broken hardware or simply asleep, so they are listed
            separately rather than recommended for deletion.
          </p>

          {registry.duplicates.length > 0 && (
            <>
              <button type="button" className="health-toggle" onClick={() => setShowCleanup((open) => !open)}>
                {showCleanup ? 'Hide' : 'Show'} {registry.duplicates.length} safe-to-delete duplicates
              </button>
              {showCleanup && (
                <ul className="health-dupes">
                  {registry.duplicates.map((duplicate) => (
                    <li key={duplicate.entityId}>
                      <code className="is-dead">{duplicate.entityId}</code>
                      <span aria-hidden="true">→</span>
                      <code>{duplicate.replacedBy}</code>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
