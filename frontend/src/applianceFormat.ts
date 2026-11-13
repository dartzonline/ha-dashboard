/** Types and wording for the departure, fridge and heating/cooling cards (kept apart for fast refresh). */

export interface Departure {
  at: string
  time: string
  day: string
  hoursAway: number
  leavingNow: boolean
  level: number | null
  levelAtDeparture: number | null
  rangeAtDeparture: number | null
  plugged: boolean
  charging: boolean
  target: number
  needsPlug: boolean
  feelsLikeC: number | null
  feelsLike?: number | null
  temperatureUnit?: string
  climate: 'warm' | 'cool' | null
}

export interface DeparturePayload {
  available: boolean
  climateButton?: string | null
  departure?: Departure | null
}

/** One sentence about the charge, and whether it needs attention. */
export function departureStatus(leave: Departure): { text: string; tone: 'ok' | 'warn' } {
  const then = leave.levelAtDeparture
  if (leave.needsPlug) return { text: `Plug in: it will still be at ${then}% when you leave.`, tone: 'warn' }
  if (leave.plugged && leave.charging) {
    return then !== null && then >= leave.target
      ? { text: 'Charging: full by then.', tone: 'ok' }
      : { text: `Charging: about ${then}% by then.`, tone: 'ok' }
  }
  if (leave.plugged) return { text: then !== null && then >= leave.target ? 'Plugged in and full.' : 'Plugged in, not charging right now.', tone: 'ok' }
  return { text: 'Not plugged in, but there is plenty for the morning.', tone: 'ok' }
}

export interface FridgeTrend {
  available: boolean
  status?: 'ok' | 'watch' | 'high' | 'learning'
  recentKwhPerDay?: number | null
  usualKwhPerDay?: number | null
  rise?: number | null
  yearlyCost?: number | null
  weeks?: { weekEnding: string; kwhPerDay: number }[]
  advice?: string[]
}

export const FRIDGE_STATUS: Record<NonNullable<FridgeTrend['status']>, string> = {
  ok: 'Normal', watch: 'Creeping up', high: 'Using more', learning: 'Learning',
}

export function percentChange(rise: number | null | undefined) {
  if (rise === null || rise === undefined) return null
  const value = Math.round(rise * 100)
  return `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(value)}%`
}

export interface HvacDay { date: string; hours: number; mode: 'cool' | 'heat' | null; cycles: number; outdoorF: number | null }

export interface HvacReport {
  available: boolean
  action?: string | null
  days?: HvacDay[]
  weekHours?: number
  avgHoursPerDay?: number | null
  cycleMinutes?: number | null
  shortCycling?: boolean
  today?: { coolH: number; heatH: number; cycles: number } | null
  efficiency?: { status: 'learning' | 'ok' | 'longer'; ratio: number | null; matchedDays: number; loggedDays: number }
  filter?: { changedOn: string | null; days: number | null; runHours: number | null; runHoursComplete?: boolean; status: 'unknown' | 'ok' | 'soon' | 'due'; dueInDays: number | null }
  advice?: string[]
}

/** "Normal for the weather", "Running 40% longer", or how long until it can tell. */
export function efficiencyLabel(efficiency: HvacReport['efficiency']) {
  if (!efficiency) return '—'
  if (efficiency.status === 'longer' && efficiency.ratio) return `Running ${Math.round((efficiency.ratio - 1) * 100)}% longer than in the same weather`
  if (efficiency.status === 'ok') return 'Normal for the weather'
  return `Learning: ${efficiency.loggedDays} day${efficiency.loggedDays === 1 ? '' : 's'} logged, compares after about three weeks`
}

export function filterLabel(filter: HvacReport['filter']) {
  if (!filter || filter.status === 'unknown' || filter.days === null) return 'Not recorded yet'
  const ago = filter.days === 0 ? 'today' : `${filter.days} day${filter.days === 1 ? '' : 's'} ago`
  const hours = filter.runHours !== null ? ` · ${filter.runHoursComplete === false ? 'at least ' : ''}${filter.runHours} h of running` : ''
  return `Changed ${ago}${hours}`
}

export function weekdayShort(iso: string) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: 'short' })
}
