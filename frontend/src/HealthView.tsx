import { useEffect, useState } from 'react'
import {
  AlertTriangle, BatteryLow, CheckCircle2, DoorOpen, HardDriveDownload,
  HeartPulse, RefreshCw, ShieldAlert, Trash2, Wrench,
} from 'lucide-react'
import { cachedJson, isAbortError } from './cachedFetch'
import type { TileConfig } from './types'
import { PageFrame } from './ui/PageFrame'
import type { Tone } from './ui/PageFrame'
import { EmptyState, InlineError, LoadingState } from './ui/StateMessages'
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

const HEALTH_PATH = 'insights/health'
/** This is state that changes on the order of hours, and the endpoint reads every entity in the house. */
const HEALTH_TTL_MS = 300_000

function attentionTitle(count: number) {
  if (count === 0) return 'Nothing needs attention'
  return `${count} thing${count === 1 ? ' needs' : 's need'} attention`
}

export function HealthView({ onExpand }: HealthViewProps) {
  const [payload, setPayload] = useState<HealthPayload | null>(null)
  const [failed, setFailed] = useState(false)
  const [showCleanup, setShowCleanup] = useState(false)
  // Bumped by Retry; re-running the effect forces a fresh read instead of the cached copy.
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    function load(force: boolean) {
      // The first read is happy with a cached copy (the page re-mounts every rotation); the slow
      // poll forces a refresh so a page left open on the wall does not go stale.
      cachedJson<HealthPayload>(HEALTH_PATH, HEALTH_PATH, HEALTH_TTL_MS, { signal: abort.signal, force })
        .then((data) => { setPayload(data); setFailed(false) })
        .catch((error: unknown) => {
          if (isAbortError(error)) return
          setFailed(true)
        })
    }
    load(retryKey > 0)
    const timer = window.setInterval(() => load(true), HEALTH_TTL_MS)
    return () => { abort.abort(); window.clearInterval(timer) }
  }, [retryKey])

  const retry = () => { setFailed(false); setRetryKey((key) => key + 1) }
  const counts = payload?.counts
  const registry = payload?.registry
  const clear = payload !== null && payload.items.length === 0
  const tone: Tone = !counts ? 'neutral'
    : counts.critical > 0 ? 'danger'
    : counts.warning > 0 ? 'warn'
    : clear ? 'good' : 'neutral'

  return (
    <section className="health-view" aria-label="Home health">
      <PageFrame
        icon={payload ? (clear ? <CheckCircle2 /> : <AlertTriangle />) : <HeartPulse />}
        title={payload ? attentionTitle(payload.items.length) : 'Home health'}
        tone={tone}
        meta={counts ? `${counts.critical} critical · ${counts.warning} warning · ${counts.info} info` : undefined}
      />

      {failed && (
        <InlineError
          message={payload ? 'Could not refresh the health check; showing the last result.' : 'Health check unavailable'}
          onRetry={retry}
        />
      )}

      {!payload && !failed && <LoadingState label="Checking home health" />}

      {payload && payload.items.length > 0 && (
        <ul className="health-list glass">
          {payload.items.map((item) => {
            const Icon = CATEGORY_ICON[item.category] ?? AlertTriangle
            const clickable = Boolean(item.entityId)
            return (
              <li key={`${item.category}-${item.title}-${item.entityId ?? ''}`} className={`is-${item.severity}`}>
                <button
                  type="button"
                  disabled={!clickable}
                  onClick={clickable
                    ? () => onExpand({ entityId: item.entityId as string, label: item.title, kind: 'sensor', icon: 'wrench' })
                    : undefined}
                  title={clickable ? `Open ${item.title}` : item.title}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span className="health-copy">
                    <span className="health-title">{item.title}</span>
                    <em>{item.detail}</em>
                  </span>
                  <small>{CATEGORY_LABEL[item.category] ?? item.category}</small>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {clear && (
        <div className="health-clear glass">
          <EmptyState
            size="compact"
            icon={<CheckCircle2 />}
            title="All clear"
            hint="No failing backups, low batteries, spent consumables, active problems or frozen sensors."
          />
        </div>
      )}

      {registry && (
        <section className="health-registry glass" aria-label="Entity registry">
          <header className="health-registry-head">
            <h3><Trash2 size={14} aria-hidden="true" />Entity registry</h3>
            <span>{registry.live} live of {registry.total}</span>
          </header>

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
              <button
                type="button"
                className="health-toggle glass-pill"
                aria-expanded={showCleanup}
                aria-controls="health-dupes"
                onClick={() => setShowCleanup((open) => !open)}
              >
                {showCleanup ? 'Hide' : 'Show'} {registry.duplicates.length} safe-to-delete duplicates
              </button>
              {showCleanup && (
                <ul className="health-dupes" id="health-dupes">
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
        </section>
      )}
    </section>
  )
}
