import { useEffect, useRef } from 'react'

const MARK = 'hcSheet'

function isSheetEntry(state: unknown) {
  return typeof state === 'object' && state !== null && (state as Record<string, unknown>)[MARK] === true
}

/**
 * The tablet's Back button should close the sheet on screen, not leave the dashboard.
 *
 * While `open` is true one extra history entry exists; Back pops it and `onBack` runs. Closing the
 * sheet any other way (the X, the scrim, idle timeout) pops that entry itself so history does not
 * fill with dead entries. It is one entry for *any* number of sheets: the caller passes "is
 * anything open", so moving from one sheet straight into another (Security -> a door's details)
 * happens in a single render and never touches history.
 */
export function useBackToClose(open: boolean, onBack: () => void) {
  const onBackRef = useRef(onBack)
  useEffect(() => { onBackRef.current = onBack })
  const pushed = useRef(false)

  useEffect(() => {
    // A reload while a sheet was open leaves the marker on the current entry with nothing to close.
    if (isSheetEntry(window.history.state)) window.history.replaceState(null, '', window.location.href)
    function onPop() {
      if (!pushed.current) return
      // The entry is already gone; closing must not pop a second one.
      pushed.current = false
      onBackRef.current()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    if (open && !pushed.current) {
      window.history.pushState({ [MARK]: true }, '', window.location.href)
      pushed.current = true
    } else if (!open && pushed.current) {
      pushed.current = false
      if (isSheetEntry(window.history.state)) window.history.back()
    }
  }, [open])
}
