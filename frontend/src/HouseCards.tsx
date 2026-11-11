import { Activity, AirVent, DoorOpen, HardDriveDownload, ShieldCheck, WifiOff } from 'lucide-react'
import type { AirSnapshot, BackupStatus, RoutineReport } from './useMorningBrief'
import './HouseCards.css'

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** "Today 6:03 am", "Tomorrow 6:02 am", "May 24". */
export function whenLabel(iso: string, now = new Date()): string {
  const date = new Date(iso)
  const days = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000)
  if (days === 0) return `Today ${clock(iso)}`
  if (days === 1) return `Tomorrow ${clock(iso)}`
  if (days === -1) return `Yesterday ${clock(iso)}`
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Automatic backups: the last good one, the last try, and what happened. */
export function BackupCard({ backup, always = false }: { backup: BackupStatus | null | undefined; always?: boolean }) {
  if (!backup || (backup.severity === 'ok' && !always)) return null
  const days = backup.daysSinceSuccess
  return (
    <section className={`house-card glass is-${backup.severity}`} aria-label="Backups">
      <header>
        {backup.severity === 'ok' ? <ShieldCheck size={16} aria-hidden="true" /> : <HardDriveDownload size={16} aria-hidden="true" />}
        <h3>Backups</h3>
        <span>{backup.severity === 'ok' ? 'Healthy' : backup.failing ? 'Failing' : 'Overdue'}</span>
      </header>
      <dl>
        <dt>Last good backup</dt>
        <dd>{backup.lastSuccess ? `${whenLabel(backup.lastSuccess)}${days !== null && days >= 2 ? ` · ${Math.round(days)} days ago` : ''}` : 'None on record'}</dd>
        {backup.lastAttempt && <><dt>Last attempt</dt><dd>{whenLabel(backup.lastAttempt)}{backup.lastResult ? ` · ${backup.lastResult.replaceAll('_', ' ')}` : ''}</dd></>}
        {backup.nextScheduled && <><dt>Next</dt><dd>{whenLabel(backup.nextScheduled)}</dd></>}
      </dl>
      {backup.severity !== 'ok' && (
        <p>{backup.failing ? 'Every attempt since then has failed. ' : ''}See Home Assistant → Settings → System → Backups for the reason; a full disk or an unreachable backup location is the usual cause.</p>
      )}
    </section>
  )
}

/** The patio-door visits, learned from the sensor, and how today is going. */
export function RoutineCard({ report }: { report: RoutineReport | null | undefined }) {
  if (!report || report.routines.length === 0) return null
  return (
    <section className="house-card glass" aria-label="Routines">
      <header><DoorOpen size={16} aria-hidden="true" /><h3>{report.label} routine</h3><span>{report.routines.filter((routine) => routine.status === 'done').length} of {report.routines.length} today</span></header>
      <ul className="routine-list">
        {report.routines.map((routine) => (
          <li key={routine.minute} className={`is-${routine.status}`}>
            <strong>{routine.time}</strong>
            <span>
              {routine.status === 'done' ? `Done at ${routine.at}${routine.minutes && routine.minutes > 1 ? ` · ${routine.minutes} min` : ''}`
                : routine.status === 'late' ? 'Not yet today'
                  : routine.status === 'expected' ? 'Due around now'
                    : 'Later'}
            </span>
            <small>{routine.daysSeen} of {routine.daysObserved} days</small>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Outdoor air quality against indoor, and what the purifier is doing. */
export function AirStrip({ air }: { air: AirSnapshot | null | undefined }) {
  if (!air || (air.outdoorAqi === null && air.indoorPm25 === null)) return null
  const bits: string[] = []
  if (air.outdoorAqi !== null) bits.push(`Outside AQI ${Math.round(air.outdoorAqi)}${air.outdoorBand ? ` (${air.outdoorBand})` : ''}`)
  if (air.indoorPm25 !== null) bits.push(`Inside PM2.5 ${Math.round(air.indoorPm25)}`)
  if (air.purifier) bits.push(`Purifier ${air.purifier.on ? 'on' : 'off'}`)
  return <p className="air-strip"><AirVent size={15} aria-hidden="true" />{bits.join(' · ')}</p>
}

export interface DropoutDevice {
  entityId: string
  name: string
  dropouts: number
  perDay: number
  lastAt: string
  usualHour: number | null
  ip: string | null
  mac: string | null
  hostname: string | null
  kind: 'wifi' | 'device'
  now: string | null
}

const hourLabel = (hour: number) => `${hour % 12 || 12} ${hour < 12 ? 'am' : 'pm'}`

export function relativeTime(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

/** Devices that keep dropping off the network or going unavailable. */
export function DropoutsPanel({ devices, days, loading, failed }: { devices: DropoutDevice[] | null; days: number; loading: boolean; failed: boolean }) {
  return (
    <div className="network-dropouts glass glass-card">
      <div className="network-panel-head">
        <h3 className="network-card-title"><WifiOff size={15} aria-hidden="true" />Keeps dropping off</h3>
        {devices && <span>last {days} days</span>}
      </div>
      {loading ? <p className="dropouts-note">Looking through the week…</p>
        : failed ? <p className="dropouts-note">Could not check dropouts.</p>
          : !devices || devices.length === 0 ? <p className="dropouts-note"><Activity size={14} aria-hidden="true" />Nothing is dropping off. Home Assistant restarts are ignored.</p>
            : <ul className="dropouts-list">
              {devices.map((device) => (
                <li key={device.entityId}>
                  <span className="dropouts-name"><strong>{device.name}</strong>
                    <small>{[device.ip, device.mac, device.hostname && device.hostname !== device.name ? device.hostname : null].filter(Boolean).join(' · ') || device.entityId}</small></span>
                  <span className="dropouts-count"><strong>{device.dropouts}</strong><small>{device.perDay}/day</small></span>
                  <span className="dropouts-when">last {relativeTime(device.lastAt)}{device.usualHour !== null ? ` · often around ${hourLabel(device.usualHour)}` : ''}</span>
                </li>
              ))}
            </ul>}
    </div>
  )
}
