import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AlertTriangle, Battery, BatteryCharging, Bot, CircleDot, Droplets, Filter, MapPin,
  Pause, Play, RotateCw, ScanLine, Sparkles, Waves,
} from 'lucide-react'
import { friendlyName } from './entityNames'
import type { HAEntity, TileConfig } from './types'
import { EmptyState, InlineError, LoadingState } from './ui/StateMessages'
import { PageFrame } from './ui/PageFrame'
import type { Tone } from './ui/PageFrame'
import './RoborockView.css'

interface RoborockViewProps {
  entities: Map<string, HAEntity>
  onService: (domain: string, service: string, data: Record<string, unknown>) => Promise<unknown>
  /** Opens the shared entity detail sheet, same as tiles in every other section. */
  onExpand: (tile: TileConfig) => void
}

const VACUUM = 'vacuum.roborock_qrevo_maxv'
const PREFIX = 'sensor.roborock_qrevo_maxv'
const BINARY = 'binary_sensor.roborock_qrevo_maxv'

/** Home Assistant's placeholder states, which must never be rendered as a figure. */
const MISSING = new Set(['unavailable', 'unknown', 'none', ''])

function numeric(entity: HAEntity | undefined) {
  if (!entity || MISSING.has(entity.state)) return null
  const value = Number(entity.state)
  return Number.isFinite(value) ? value : null
}

function humanise(state: string | undefined) {
  if (!state || MISSING.has(state)) return '--'
  return state.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())
}

function relative(iso: string | undefined) {
  if (!iso) return null
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return null
  const minutes = Math.round((Date.now() - parsed) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function hoursLabel(hours: number) {
  if (hours <= 0) return `${Math.abs(Math.round(hours))}h overdue`
  return hours < 10 ? `${hours.toFixed(1)}h left` : `${Math.round(hours)}h left`
}

function minutesLabel(minutes: number) {
  if (minutes < 60) return `${Math.round(minutes)}m`
  return `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`
}

/**
 * Roborock publishes only the hours *remaining* on each consumable, never the
 * interval they count down from, so a bar needs the totals supplied here. These
 * are Roborock's documented service intervals, and every live reading sits
 * inside its own figure -- a remaining value above one would mean it is wrong.
 */
const CONSUMABLES: { entityId: string; label: string; icon: string; glyph: ReactNode; totalHours: number }[] = [
  { entityId: `${PREFIX}_filter_time_left`, label: 'Filter', icon: 'filter', glyph: <Filter size={13} />, totalHours: 150 },
  { entityId: `${PREFIX}_main_brush_time_left`, label: 'Main brush', icon: 'rotate-cw', glyph: <RotateCw size={13} />, totalHours: 300 },
  { entityId: `${PREFIX}_side_brush_time_left`, label: 'Side brush', icon: 'rotate-cw', glyph: <CircleDot size={13} />, totalHours: 200 },
  { entityId: `${PREFIX}_sensor_time_left`, label: 'Sensors', icon: 'scan', glyph: <ScanLine size={13} />, totalHours: 30 },
]

/**
 * Dock rows. `problem` sensors read backwards from the attached/running ones --
 * `on` means something is wrong -- so each row says how to read its own state
 * rather than assuming `on` is good.
 */
const DOCK_ROWS: {
  entityId: string
  label: string
  icon: string
  onLabel: string
  offLabel: string
  badWhenOn: boolean
}[] = [
  { entityId: `${BINARY}_water_box_attached`, label: 'Water box', icon: 'droplets', onLabel: 'Attached', offLabel: 'Not attached', badWhenOn: false },
  { entityId: `${BINARY}_dock_clean_water_box`, label: 'Clean water', icon: 'droplets', onLabel: 'Needs refilling', offLabel: 'Full', badWhenOn: true },
  { entityId: `${BINARY}_dock_dirty_water_box`, label: 'Dirty water', icon: 'waves', onLabel: 'Needs emptying', offLabel: 'Has room', badWhenOn: true },
  { entityId: `${BINARY}_dock_cleaning_fluid`, label: 'Cleaning fluid', icon: 'droplets', onLabel: 'Low', offLabel: 'OK', badWhenOn: true },
  { entityId: `${BINARY}_water_shortage`, label: 'Water shortage', icon: 'waves', onLabel: 'Yes', offLabel: 'No', badWhenOn: true },
  { entityId: `${BINARY}_mop_attached`, label: 'Mop', icon: 'sparkles', onLabel: 'Attached', offLabel: 'Not attached', badWhenOn: false },
  { entityId: `${BINARY}_dock_mop_drying`, label: 'Mop drying', icon: 'sparkles', onLabel: 'Drying', offLabel: 'Idle', badWhenOn: false },
]

/** The two error enums, whose "everything is fine" values differ per entity. */
const ERROR_SENSORS: { entityId: string; label: string; clear: string }[] = [
  { entityId: `${PREFIX}_vacuum_error`, label: 'Robot', clear: 'none' },
  { entityId: `${PREFIX}_dock_dock_error`, label: 'Dock', clear: 'ok' },
]

/** How long an armed confirmation waits for its second tap, matching useTwoTapConfirm. */
const CONFIRM_MS = 4_000

export function RoborockView({ entities, onService, onExpand }: RoborockViewProps) {
  const [pending, setPending] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // One armed control at a time. useTwoTapConfirm holds a single flag, and two of these controls
  // can ask for confirmation, so the armed control's id is tracked here instead.
  const [armed, setArmed] = useState<string | null>(null)

  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(null), CONFIRM_MS)
    return () => window.clearTimeout(timer)
  }, [armed])

  const vacuum = entities.get(VACUUM)
  const offline = !vacuum || MISSING.has(vacuum.state)
  const statusSensor = entities.get(`${PREFIX}_status`)
  const status = humanise(statusSensor?.state ?? vacuum?.state)
  const battery = numeric(entities.get(`${PREFIX}_battery`))
  const charging = entities.get(`${BINARY}_charging`)?.state === 'on'
  const cleaning = entities.get(`${BINARY}_cleaning`)?.state === 'on'
  const room = entities.get(`${PREFIX}_current_room`)
  const fanSpeed = typeof vacuum?.attributes.fan_speed === 'string' ? vacuum.attributes.fan_speed : null

  const lastEnd = entities.get(`${PREFIX}_last_clean_end`)
  const lastClean = relative(lastEnd?.state)
  const cleanMinutes = numeric(entities.get(`${PREFIX}_cleaning_time`))
  const cleanArea = numeric(entities.get(`${PREFIX}_cleaning_area`))
  const progress = numeric(entities.get(`${PREFIX}_cleaning_progress`))
  const totalCleans = numeric(entities.get(`${PREFIX}_total_cleaning_count`))
  const totalArea = numeric(entities.get(`${PREFIX}_total_cleaning_area`))
  const totalHours = numeric(entities.get(`${PREFIX}_total_cleaning_time`))
  const dryingLeft = numeric(entities.get(`${PREFIX}_dock_mop_drying_remaining_time`))
  const strainer = numeric(entities.get(`${PREFIX}_dock_strainer_time_left`))
  const dockBrush = numeric(entities.get(`${PREFIX}_dock_maintenance_brush_time_left`))

  const problems: { entityId: string; label: string; detail: string; icon: string }[] = [
    ...DOCK_ROWS.filter((row) => row.badWhenOn && entities.get(row.entityId)?.state === 'on')
      .map((row) => ({ entityId: row.entityId, label: row.label, detail: row.onLabel, icon: row.icon })),
    ...ERROR_SENSORS.flatMap((sensor) => {
      const entity = entities.get(sensor.entityId)
      if (!entity || MISSING.has(entity.state) || entity.state === sensor.clear) return []
      return [{ entityId: sensor.entityId, label: `${sensor.label} error`, detail: humanise(entity.state), icon: 'bot' }]
    }),
    // A consumable past its interval needs a part swap, which belongs in the same
    // "what needs my hands" count as a full dirty-water tank.
    ...CONSUMABLES.flatMap((item) => {
      const hours = numeric(entities.get(item.entityId))
      if (hours === null || hours > 0) return []
      return [{ entityId: item.entityId, label: item.label, detail: 'Past service interval', icon: item.icon }]
    }),
  ]

  function expand(entityId: string, label: string, icon: string, kind: TileConfig['kind'] = 'sensor') {
    if (!entities.has(entityId)) return
    onExpand({ entityId, label, kind, icon })
  }

  async function send(id: string, service: string, confirmation?: string) {
    // window.confirm blocks the socket and is suppressed in some kiosk WebViews, so a risky
    // command arms on the first tap and fires on the second.
    if (confirmation && armed !== id) {
      setArmed(id)
      return
    }
    setArmed(null)
    setPending(id)
    setNotice(null)
    try {
      await onService('vacuum', service, { entity_id: VACUUM })
    } catch (error) {
      // The backend's `detail` (a refused service, HA offline) says what actually went wrong.
      setNotice(error instanceof Error && error.message
        ? `Could not send that command to the vacuum: ${error.message}`
        : 'Could not send that command to the vacuum.')
    } finally {
      setPending(null)
    }
  }

  const hasRoborock = Boolean(vacuum) || Array.from(entities.keys()).some((id) => id.startsWith(PREFIX) || id.startsWith(BINARY))
  if (!hasRoborock) {
    // An empty map means the socket has not delivered its first snapshot yet, not that there is no vacuum.
    return entities.size === 0 ? (
      <PageFrame className="roborock-view" icon={<Bot />} title="Connecting">
        <LoadingState label="Waiting for Home Assistant" />
      </PageFrame>
    ) : (
      <PageFrame className="roborock-view" icon={<Bot />} title="No vacuum connected">
        <EmptyState
          icon={<Bot />}
          title="No Roborock vacuum found"
          hint={`Looks for ${VACUUM} and its ${PREFIX}_* sensors from the Roborock integration.`}
        />
      </PageFrame>
    )
  }

  const waterTrouble = problems.some((problem) => problem.entityId.includes('water'))
  const controls: { id: string; label: string; glyph: ReactNode; service: string; primary?: boolean; confirmation?: string }[] = [
    {
      id: 'start',
      label: cleaning ? 'Resume' : 'Clean',
      glyph: <Play size={16} />,
      service: 'start',
      primary: true,
      // Mopping with an empty clean-water tank drags a dry pad over the floor.
      confirmation: waterTrouble ? 'The dock reports a water problem. Tap again to start cleaning anyway.' : undefined,
    },
    { id: 'pause', label: 'Pause', glyph: <Pause size={16} />, service: 'pause' },
    {
      id: 'dock',
      label: 'Return to dock',
      glyph: <Bot size={16} />,
      service: 'return_to_base',
      confirmation: cleaning ? 'Tap again to send the vacuum back to its dock and end this clean.' : undefined,
    },
    { id: 'locate', label: 'Locate', glyph: <MapPin size={16} />, service: 'locate' },
  ]
  const armedControl = controls.find((control) => control.id === armed && control.confirmation)

  const batteryLow = battery !== null && battery <= 20
  const cards: {
    entityId: string
    label: string
    icon: string
    tone?: Tone
    glyph: ReactNode
    value: string
    detail: string
    kind?: TileConfig['kind']
    meter?: number
  }[] = [
    {
      entityId: VACUUM,
      label: 'Status',
      icon: 'bot',
      tone: cleaning ? 'accent' : undefined,
      glyph: <Bot size={15} />,
      kind: 'vacuum',
      value: status,
      detail: cleaning && progress !== null
        ? `${Math.round(progress)}% done${room && !MISSING.has(room.state) ? ` · ${room.state}` : ''}`
        : fanSpeed ? `Fan ${fanSpeed}` : offline ? 'Vacuum unavailable' : 'Idle at dock',
    },
    {
      entityId: `${PREFIX}_battery`,
      label: 'Battery',
      icon: 'battery',
      tone: batteryLow ? 'danger' : undefined,
      glyph: charging ? <BatteryCharging size={15} /> : <Battery size={15} />,
      value: battery === null ? '--' : `${Math.round(battery)}%`,
      detail: charging ? 'Charging on dock' : battery === null ? 'Not reported' : batteryLow ? 'Low, on battery' : 'On battery',
      meter: battery === null ? undefined : Math.max(0, Math.min(100, battery)),
    },
    {
      entityId: `${PREFIX}_last_clean_end`,
      label: 'Last clean',
      icon: 'rotate-cw',
      glyph: <RotateCw size={15} />,
      value: lastClean ?? '--',
      detail: [
        cleanMinutes !== null ? minutesLabel(cleanMinutes) : null,
        cleanArea !== null ? `${cleanArea} m²` : null,
      ].filter(Boolean).join(' · ') || 'No clean recorded',
    },
    problems.length > 0
      ? {
        entityId: problems[0].entityId,
        label: 'Needs attention',
        icon: problems[0].icon,
        tone: 'danger',
        glyph: <AlertTriangle size={15} />,
        value: problems[0].label,
        detail: problems.length > 1 ? `${problems[0].detail} · +${problems.length - 1} more` : problems[0].detail,
      }
      : {
        entityId: `${PREFIX}_vacuum_error`,
        label: 'Needs attention',
        icon: 'bot',
        glyph: <Sparkles size={15} />,
        value: 'All clear',
        detail: 'No dock or robot faults',
      },
  ]

  const reportedConsumables = CONSUMABLES.filter((item) => numeric(entities.get(item.entityId)) !== null)

  // The sub-heading is what someone glancing at the wall wants: what it is doing and how full it is.
  const title = [status === '--' ? (offline ? 'Unavailable' : null) : status, battery === null ? null : `${Math.round(battery)}%`]
    .filter(Boolean).join(' · ') || 'Vacuum'
  const pageTone: Tone = problems.length > 0 ? 'warn' : cleaning ? 'accent' : 'neutral'
  const meta = cleaning && progress !== null
    ? `${Math.round(progress)}% done${room && !MISSING.has(room.state) ? ` · ${room.state}` : ''}`
    : problems.length > 0
      ? `${problems.length} to fix`
      : lastClean ? `Last clean ${lastClean}` : undefined

  return (
    <PageFrame
      className="roborock-view"
      icon={charging ? <BatteryCharging /> : <Bot />}
      eyebrow={friendlyName(vacuum, 'Roborock Qrevo MaxV')}
      title={title}
      tone={pageTone}
      meta={meta}
    >
      {notice && <InlineError message={notice} />}

      {/* Buttons, not read-only figures: each fronts a real entity so a tap opens
          the same detail sheet with history that tiles elsewhere do. */}
      <div className="roborock-cards">
        {cards.map((card) => {
          const linked = entities.has(card.entityId)
          return (
            <button
              key={card.label}
              type="button"
              className={`roborock-card glass glass-card${card.tone ? ` tone-${card.tone}` : ''}`}
              onClick={linked ? () => expand(card.entityId, card.label, card.icon, card.kind) : undefined}
              disabled={!linked}
              title={linked ? `Open ${card.label} history` : `${card.label} is unavailable`}
            >
              <span className="roborock-card-label">{card.glyph} {card.label}</span>
              <strong>{card.value}</strong>
              {card.meter !== undefined && (
                <span
                  className="roborock-meter glass-inset"
                  role="meter"
                  aria-label="Battery charge"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(card.meter)}
                >
                  <i style={{ width: `${card.meter}%` }} />
                </span>
              )}
              <small>{card.detail}</small>
            </button>
          )
        })}
      </div>

      <div className="roborock-controls" role="group" aria-label="Vacuum controls">
        {controls.map((control) => {
          const isArmed = armedControl?.id === control.id
          return (
            <button
              key={control.id}
              type="button"
              className={`glass-pill${control.primary ? ' tone-accent' : ''}${isArmed ? ' tone-warn is-armed' : ''}`}
              onClick={() => void send(control.id, control.service, control.confirmation)}
              disabled={offline || pending !== null}
              title={offline ? 'The vacuum is unavailable' : control.label}
            >
              {isArmed ? <AlertTriangle size={16} /> : control.glyph}
              {pending === control.id ? 'Sending…' : isArmed ? 'Tap to confirm' : control.label}
            </button>
          )
        })}
        {armedControl && <p className="roborock-controls-note is-armed" role="status">{armedControl.confirmation}</p>}
        {offline && !armedControl && <p className="roborock-controls-note">The vacuum is not reporting, so controls are disabled.</p>}
      </div>

      <div className="roborock-lower">
        <section className="roborock-consumables glass glass-card" aria-label="Consumables">
          <header className="roborock-card-head">
            <Filter size={15} aria-hidden="true" />
            <h3>Consumables</h3>
            {totalHours !== null && <span>{Math.round(totalHours)}h cleaned total</span>}
          </header>
          {reportedConsumables.length === 0 ? (
            <EmptyState size="compact" icon={<Filter />} title="Not reported" hint={`Looks for ${PREFIX}_*_time_left sensors.`} />
          ) : (
            <ul>
              {CONSUMABLES.map((item) => {
                const entity = entities.get(item.entityId)
                const hours = numeric(entity)
                if (hours === null) {
                  return (
                    <li key={item.entityId} className="is-unreported">
                      <span>{item.glyph} {item.label}</span>
                      <em>Not reported</em>
                    </li>
                  )
                }
                const percent = Math.max(0, Math.min(100, (hours / item.totalHours) * 100))
                // Status tints only once a part is near its interval, and always with a word, so the
                // colour never has to be decoded on its own.
                const tone = percent <= 5 ? 'is-bad' : percent <= 20 ? 'is-warn' : 'is-good'
                const word = tone === 'is-bad' ? 'Replace' : tone === 'is-warn' ? 'Due soon' : null
                return (
                  <li key={item.entityId}>
                    <button
                      type="button"
                      className={tone}
                      onClick={() => expand(item.entityId, item.label, item.icon)}
                      title={`Open ${item.label} history`}
                    >
                      <span>{item.glyph} {item.label}</span>
                      <em>{word ? `${word} · ` : ''}{hoursLabel(hours)}</em>
                      <small>{Math.round(percent)}%</small>
                      <i className="glass-inset" aria-hidden="true"><b style={{ width: `${percent}%` }} /></i>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          <p className="roborock-note">
            Percentages are the hours remaining against each part’s service interval:
            {' '}150h filter, 300h main brush, 200h side brush, 30h sensors.
          </p>
        </section>

        <section className="roborock-dock glass glass-card" aria-label="Dock and maintenance">
          <header className="roborock-card-head">
            <Droplets size={15} aria-hidden="true" />
            <h3>Dock &amp; maintenance</h3>
            <span className={problems.length > 0 ? 'is-attention' : undefined}>{problems.length > 0 ? `${problems.length} to fix` : 'All clear'}</span>
          </header>
          <ul>
            {DOCK_ROWS.map((row) => {
              const entity = entities.get(row.entityId)
              const known = entity && !MISSING.has(entity.state)
              const on = entity?.state === 'on'
              const bad = Boolean(known && row.badWhenOn && on)
              return (
                <li key={row.entityId}>
                  <button
                    type="button"
                    className={bad ? 'is-bad' : known && !row.badWhenOn && on ? 'is-good' : ''}
                    onClick={() => expand(row.entityId, row.label, row.icon)}
                    disabled={!entity}
                    title={entity ? `Open ${row.label} history` : `${row.label} is unavailable`}
                  >
                    <i aria-hidden="true" />
                    <span>{row.label}</span>
                    <em>{known ? (on ? row.onLabel : row.offLabel) : 'Not reported'}</em>
                  </button>
                </li>
              )
            })}
            {ERROR_SENSORS.map((sensor) => {
              const entity = entities.get(sensor.entityId)
              const known = entity && !MISSING.has(entity.state)
              const bad = Boolean(known && entity.state !== sensor.clear)
              return (
                <li key={sensor.entityId}>
                  <button
                    type="button"
                    className={bad ? 'is-bad' : ''}
                    onClick={() => expand(sensor.entityId, `${sensor.label} error`, 'bot')}
                    disabled={!entity}
                    title={entity ? `Open ${sensor.label} error history` : `${sensor.label} error is unavailable`}
                  >
                    <i aria-hidden="true" />
                    <span>{sensor.label} error</span>
                    <em>{known ? (bad ? humanise(entity.state) : 'None') : 'Not reported'}</em>
                  </button>
                </li>
              )
            })}
          </ul>
          <dl>
            <dt>Mop drying left</dt>
            <dd>{dryingLeft === null ? '—' : dryingLeft > 0 ? `${dryingLeft.toFixed(1)} h` : 'Dry'}</dd>
            <dt>Dock strainer</dt>
            <dd>{strainer === null ? '—' : hoursLabel(strainer)}</dd>
            <dt>Dock brush</dt>
            <dd>{dockBrush === null ? 'Not reported' : hoursLabel(dockBrush)}</dd>
          </dl>
        </section>

        <section className="roborock-totals glass glass-card" aria-label="Lifetime">
          <header className="roborock-card-head">
            <Waves size={15} aria-hidden="true" />
            <h3>Lifetime</h3>
          </header>
          <dl>
            <dt>Cleans</dt>
            <dd>{totalCleans === null ? '—' : Math.round(totalCleans)}</dd>
            <dt>Area</dt>
            <dd>{totalArea === null ? '—' : `${Math.round(totalArea)} m²`}</dd>
            <dt>Run time</dt>
            <dd>{totalHours === null ? '—' : `${Math.round(totalHours)} h`}</dd>
            <dt>Last ended</dt>
            <dd>{lastEnd && !MISSING.has(lastEnd.state)
              ? new Date(lastEnd.state).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
              : '—'}</dd>
          </dl>
        </section>
      </div>
    </PageFrame>
  )
}
