import { useEffect, useRef, useState } from 'react'
import { Activity, Ban, Clock3, Gauge, Link2, ListChecks, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react'
import { adguardModel, blockingState, compactCount, isLinked, number, sinceLabel, SWITCH_LABELS } from './adguard'
import type { AdGuardStatKey } from './adguard'
import type { AdGuardSwitchKey } from './adguard'
import { AdGuardCharts } from './AdGuardCharts'
import { StateTimeline } from './StateTimeline'
import type { HAEntity } from './types'
import './AdGuardTab.css'

interface AdGuardTabProps {
  entities: Map<string, HAEntity>
  onService: (domain: string, service: string, data: Record<string, unknown>) => Promise<unknown>
}

/** The count each filter keeps, shown on its row: how many lookups it has caught. */
const FILTER_COUNT: Partial<Record<AdGuardSwitchKey, { stat: AdGuardStatKey; word: string }>> = {
  safeBrowsing: { stat: 'safeBrowsingBlocked', word: 'blocked' },
  parental: { stat: 'parentalBlocked', word: 'blocked' },
  safeSearch: { stat: 'safeSearches', word: 'enforced' },
}

/** Switching one of these off stops ads being blocked, so it takes a second tap. */
const NEEDS_CONFIRM: AdGuardSwitchKey[] = ['protection', 'filtering']
const CONFIRM_MS = 4_000
const isUnreachable = (state: string) => state === 'unavailable' || state === 'unknown'

const HEADLINES = {
  working: { title: 'Blocking ads and trackers', detail: 'Protection and filtering are both on.' },
  'protection-off': { title: 'Protection is off', detail: 'Nothing is being blocked on any device using AdGuard.' },
  'filtering-off': { title: 'Filtering is off', detail: 'Protection is on, but the blocklists are not being applied.' },
  unknown: { title: 'AdGuard is not answering', detail: 'Home Assistant cannot reach it right now.' },
} as const

function SetupSteps({ version }: { version: string | null }) {
  return (
    <section className="adguard-setup glass glass-card" aria-label="Connect AdGuard Home">
      <span className="adguard-setup-icon" aria-hidden="true"><Link2 size={26} /></span>
      <div className="adguard-setup-body">
        <h3>Connect AdGuard Home to Home Assistant</h3>
        <p>
          {version
            ? `The AdGuard Home add-on (${version}) is installed, but Home Assistant is not linked to it yet, so there is nothing to show here.`
            : 'Home Assistant does not have AdGuard Home yet.'}
        </p>
        <ol>
          <li>In Home Assistant open <strong>Settings → Devices &amp; services</strong>.</li>
          <li>It usually appears under <strong>Discovered</strong> as AdGuard Home: press <strong>Configure</strong>. Otherwise choose <strong>Add integration</strong> and search for it.</li>
          <li>Accept the add-on's details. No password is needed for the add-on.</li>
        </ol>
        <p className="adguard-setup-foot">This tab then fills in with protection status, how many lookups were blocked, and the filter switches. History starts the moment it is linked.</p>
      </div>
    </section>
  )
}

function Stat({ icon, label, value, unit, detail }: { icon: React.ReactNode; label: string; value: string; unit?: string; detail?: string }) {
  return (
    <div className="adguard-stat glass glass-card">
      <span>{icon}{label}</span>
      <strong>{value}{unit && <small>{unit}</small>}</strong>
      {detail && <em>{detail}</em>}
    </div>
  )
}

export function AdGuardTab({ entities, onService }: AdGuardTabProps) {
  const model = adguardModel(entities)
  const [armed, setArmed] = useState<AdGuardSwitchKey | null>(null)
  const [busy, setBusy] = useState<AdGuardSwitchKey | null>(null)
  const [error, setError] = useState<string | null>(null)
  const armTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(armTimer.current), [])

  if (!isLinked(model)) {
    return <SetupSteps version={model.addon ? String(model.addon.attributes.installed_version ?? '') || null : null} />
  }

  const blocking = blockingState(model)
  const headline = HEADLINES[blocking]
  const protection = model.switches.protection
  const filtering = model.switches.filtering
  const heroTarget: AdGuardSwitchKey = blocking === 'filtering-off' && filtering ? 'filtering' : 'protection'
  const heroEntity = model.switches[heroTarget]
  const updateAvailable = model.addon?.state === 'on'
  const latestVersion = model.addon ? String(model.addon.attributes.latest_version ?? '') || null : null
  const queries = number(model.stats.queries)
  const blocked = number(model.stats.blocked)
  const ratio = number(model.stats.ratio) ?? (queries && blocked !== null ? (blocked / queries) * 100 : null)
  const speed = number(model.stats.speed)

  async function flip(key: AdGuardSwitchKey) {
    const entity = model.switches[key]
    if (!entity) return
    const turningOff = entity.state === 'on'
    if (turningOff && NEEDS_CONFIRM.includes(key) && armed !== key) {
      setArmed(key)
      window.clearTimeout(armTimer.current)
      armTimer.current = window.setTimeout(() => setArmed(null), CONFIRM_MS)
      return
    }
    window.clearTimeout(armTimer.current)
    setArmed(null)
    setBusy(key)
    setError(null)
    try {
      await onService('switch', turningOff ? 'turn_off' : 'turn_on', { entity_id: entity.entity_id })
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : `Could not change ${SWITCH_LABELS[key].label.toLowerCase()}`)
    } finally {
      setBusy(null)
    }
  }

  const heroButtonText = busy === heroTarget ? 'Working…'
    : heroTarget === 'filtering' ? 'Switch filtering on'
    : heroEntity?.state === 'on' ? (armed === 'protection' ? 'Tap again to switch off' : 'Switch off') : 'Switch on'

  return (
    <div className="adguard-page">
      <section className={`adguard-hero glass glass-card is-${blocking}`} aria-label="Protection status">
        <span className="adguard-shield" aria-hidden="true">
          {blocking === 'working' ? <ShieldCheck size={30} /> : blocking === 'unknown' ? <ShieldAlert size={30} /> : <ShieldOff size={30} />}
        </span>
        <div className="adguard-hero-copy">
          <h3>
            {headline.title}
            {updateAvailable && (
              <span className="adguard-update">{latestVersion ? `Update ${latestVersion}` : 'Update available'}</span>
            )}
          </h3>
          <p>{headline.detail}{protection && sinceLabel(protection.last_changed) ? ` · protection last changed ${sinceLabel(protection.last_changed)}` : ''}</p>
        </div>
        {heroEntity && (
          <button
            type="button"
            className={`adguard-master glass-pill${armed === heroTarget ? ' is-armed' : ''}${heroEntity.state !== 'on' ? ' is-primary' : ''}`}
            onClick={() => void flip(heroTarget)}
            disabled={busy !== null || isUnreachable(heroEntity.state)}
          >
            {heroButtonText}
          </button>
        )}
      </section>

      <div className="adguard-stats">
        <Stat icon={<Activity size={14} aria-hidden="true" />} label="Lookups" value={compactCount(queries)} detail="last 24 hours" />
        <Stat icon={<Ban size={14} aria-hidden="true" />} label="Blocked" value={compactCount(blocked)} detail="ads, trackers and threats" />
        <Stat icon={<ShieldCheck size={14} aria-hidden="true" />} label="Block rate" value={ratio === null ? '—' : ratio.toFixed(1)} unit={ratio === null ? undefined : '%'} detail={ratio === null ? undefined : 'of all lookups'} />
        <Stat icon={<Gauge size={14} aria-hidden="true" />} label="Speed" value={speed === null ? '—' : speed.toFixed(speed < 10 ? 1 : 0)} unit={speed === null ? undefined : ' ms'} detail="average answer time" />
      </div>

      <div className="adguard-lower">
        <section className="adguard-switches glass glass-card" aria-label="Filters">
          <header className="adguard-head"><h3><ListChecks size={15} aria-hidden="true" />Filters</h3>{model.stats.rules && <span>{compactCount(number(model.stats.rules))} rules loaded</span>}</header>
          <ul>
            {(Object.keys(SWITCH_LABELS) as AdGuardSwitchKey[]).filter((key) => key !== 'protection' && model.switches[key]).map((key) => {
              const entity = model.switches[key] as HAEntity
              const on = entity.state === 'on'
              const counted = FILTER_COUNT[key]
              const count = counted && model.stats[counted.stat] ? { value: number(model.stats[counted.stat]), word: counted.word } : null
              return (
                <li key={key}>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    className={on ? 'is-on' : ''}
                    onClick={() => void flip(key)}
                    disabled={busy !== null || isUnreachable(entity.state)}
                  >
                    <span className="adguard-switch-copy"><strong>{SWITCH_LABELS[key].label}</strong><em>{armed === key ? 'Tap again to switch off' : SWITCH_LABELS[key].hint}</em></span>
                    {count && <span className="adguard-count">{compactCount(count.value)} {count.word}</span>}
                    <span className="adguard-pill">{busy === key ? '…' : entity.state === 'unavailable' ? 'Offline' : entity.state === 'unknown' ? 'Unknown' : on ? 'On' : 'Off'}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          {error && <p className="adguard-error" role="alert">{error}</p>}
        </section>

        <section className="adguard-history glass glass-card" aria-label="Protection history and trends">
          <header className="adguard-head"><h3><Clock3 size={15} aria-hidden="true" />Protection and trends, last 24 hours</h3></header>
          {protection && (
            <StateTimeline entityId={protection.entity_id} currentState={protection.state} formatState={(state) => (state === 'on' ? 'On' : state === 'off' ? 'Off' : state)} />
          )}
          <AdGuardCharts ids={{
            queries: model.stats.queries?.entity_id,
            blocked: model.stats.blocked?.entity_id,
            ratio: model.stats.ratio?.entity_id,
            speed: model.stats.speed?.entity_id,
          }} />
        </section>
      </div>
    </div>
  )
}
