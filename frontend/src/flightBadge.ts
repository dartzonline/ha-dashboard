import a320Raw from './assets/aircraft/a320.svg?raw'
import a330Raw from './assets/aircraft/a330.svg?raw'
import a340Raw from './assets/aircraft/a340.svg?raw'
import a380Raw from './assets/aircraft/a380.svg?raw'
import b737Raw from './assets/aircraft/b737.svg?raw'
import b747Raw from './assets/aircraft/b747.svg?raw'
import b767Raw from './assets/aircraft/b767.svg?raw'
import b777Raw from './assets/aircraft/b777.svg?raw'
import b787Raw from './assets/aircraft/b787.svg?raw'
import crjxRaw from './assets/aircraft/crjx.svg?raw'
import md11Raw from './assets/aircraft/md11.svg?raw'

/**
 * The pack ships each aircraft as a standalone 512x512 document with hard-coded black fills. Only
 * the body is kept so it can be dropped inside an `<svg>` this app controls, and the black is
 * swapped for `currentColor` so the banner's tone drives the artwork.
 */
function artOf(raw: string) {
  const bodyStart = raw.indexOf('>', raw.indexOf('<svg')) + 1
  return raw.slice(bodyStart, raw.lastIndexOf('</svg>')).replace(/#000000/gi, 'currentColor')
}

export const AIRCRAFT_ART = {
  a320: artOf(a320Raw),
  a330: artOf(a330Raw),
  a340: artOf(a340Raw),
  a380: artOf(a380Raw),
  b737: artOf(b737Raw),
  b747: artOf(b747Raw),
  b767: artOf(b767Raw),
  b777: artOf(b777Raw),
  b787: artOf(b787Raw),
  crjx: artOf(crjxRaw),
  md11: artOf(md11Raw),
}

export type ArtKey = keyof typeof AIRCRAFT_ART

export function artKeyForAircraft(type: string | null | undefined): ArtKey {
  const token = (type ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (/A38[0-9X]/.test(token)) return 'a380'
  // No dedicated A350 silhouette in the pack; the A330 twin-widebody profile is the closest match.
  if (/A35[0-9KX]/.test(token)) return 'a330'
  if (/A34[0-9X]/.test(token)) return 'a340'
  if (/A33[0-9X]/.test(token)) return 'a330'
  if (/B74[0-9SRFM]/.test(token) || /747/.test(token)) return 'b747'
  if (/B77[0-9WL]/.test(token) || /777/.test(token)) return 'b777'
  if (/B78[0-9X]/.test(token) || /787/.test(token)) return 'b787'
  if (/B76[0-9]/.test(token) || /767/.test(token)) return 'b767'
  if (/MD11|L101/.test(token)) return 'md11'
  if (/CRJ|ERJ|E1(3[05]|4[05]|70|75|90|95)|E75[LS]/.test(token)) return 'crjx'
  if (/B73[0-9HMS]|A32[01]|A31[89]|737|320/.test(token)) return 'b737'
  return 'a320'
}

export interface TrackSchedule {
  depScheduled?: string | null
  depActual?: string | null
  arrScheduled?: string | null
  arrEstimated?: string | null
  delayMin?: number | null
  status?: string | null
}

/** Upstream sends "2026-08-04 06:15"; only the clock time fits in a header chip. */
export function clockOf(value: string | null | undefined) {
  if (!value) return null
  const match = /(\d{1,2}:\d{2})/.exec(value)
  return match ? match[1] : null
}

/**
 * Whether the flight is going to land when it said it would. On time reads green, a small slip
 * amber, a real delay red. A null delay means the schedule source has not said yet — that is not
 * the same as on time, so it stays neutral rather than claiming good news.
 */
export function arrivalVerdict(schedule: TrackSchedule | undefined) {
  const delay = schedule?.delayMin
  if (delay === null || delay === undefined) {
    const status = schedule?.status
    return status ? { tone: 'muted', label: status.replace(/^./, (c) => c.toUpperCase()) } : null
  }
  const late = Math.round(delay)
  if (late <= 0) return { tone: 'good', label: 'On time' }
  if (late <= 15) return { tone: 'warn', label: `${late} min late` }
  return { tone: 'danger', label: `${late} min late` }
}
