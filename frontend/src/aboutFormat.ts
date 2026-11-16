/** "Nov 16, 2026" from a release day written as 2026-11-16, without a time zone shifting it a day. */
export function formatReleased(day: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return null
  const when = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (Number.isNaN(when.getTime())) return null
  return when.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}
