/** Mornings run from 5 am to 11 am; outside them the Morning page stays in the sidebar only. */
export const MORNING_START_HOUR = 5
export const MORNING_END_HOUR = 11
/** How often, in the morning, rotation comes back round to the Morning page. */
export const MORNING_REPEAT_MS = 30 * 60_000

export function isMorning(now: Date) {
  const hour = now.getHours()
  return hour >= MORNING_START_HOUR && hour < MORNING_END_HOUR
}

/**
 * The section rotation moves to after `current`. Outside the morning, Morning is skipped; in the
 * morning it is the stop rotation makes first, and again whenever half an hour has passed since
 * it was last on screen, so the brief keeps coming back while people are getting ready.
 */
export function nextRotationSection(sectionIds: string[], current: string, now: Date, morningShownAt: number | null): string | null {
  const morning = isMorning(now)
  if (morning && current !== 'morning' && sectionIds.includes('morning')
    && (morningShownAt === null || now.getTime() - morningShownAt >= MORNING_REPEAT_MS)) {
    return 'morning'
  }
  const order = sectionIds.filter((id) => id !== 'morning')
  if (order.length === 0) return null
  // A section rotation skips (Scenes, Photos, Morning) is not in the list, so `indexOf` is -1 and
  // the +1 lands on the first section -- what should happen when the cycle resumes from one of them.
  return order[(order.indexOf(current) + 1) % order.length]
}
