import type { KeyboardEvent } from 'react'

/**
 * Arrow-key roving for a `role="tablist"` (WAI-ARIA tabs pattern, automatic activation).
 *
 * Put the returned handler on the tablist element; each tab needs `role="tab"`,
 * `aria-selected`, `aria-controls`, and `tabIndex={selected ? 0 : -1}` so Tab lands on the
 * current tab and the arrows move between them. Left/Up and Right/Down step (wrapping), Home/End
 * jump. Selection follows focus, which is right here: every panel is already rendered data and
 * switching is instant.
 */
export function tabListKeyHandler<T>(values: readonly T[], current: T, onSelect: (value: T) => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    const index = values.indexOf(current)
    let next: number
    switch (event.key) {
      case 'ArrowRight': case 'ArrowDown': next = (index + 1) % values.length; break
      case 'ArrowLeft': case 'ArrowUp': next = (index - 1 + values.length) % values.length; break
      case 'Home': next = 0; break
      case 'End': next = values.length - 1; break
      default: return
    }
    event.preventDefault()
    // Stop the page-level arrow handling (if any) from also treating this as section navigation.
    event.stopPropagation()
    onSelect(values[next])
    const tabs = event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')
    tabs[next]?.focus()
  }
}
