import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Touch-friendly confirmation without a browser dialog.
 *
 * `window.confirm` ignores the panel's type scale, blocks the JS thread (so websocket frames
 * queue), and is suppressed outright in some kiosk WebViews — which would make Night Mode silently
 * impossible to trigger. Instead the first tap arms the control ("Tap again to confirm"), the
 * second tap fires, and doing nothing for `timeoutMs` disarms it again.
 */
export function useTwoTapConfirm(timeoutMs = 4_000) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  const disarm = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = undefined
    setArmed(false)
  }, [])

  /** Call from the button's onClick. Returns true when the action should run. */
  const request = useCallback(() => {
    if (armed) {
      disarm()
      return true
    }
    setArmed(true)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setArmed(false), timeoutMs)
    return false
  }, [armed, disarm, timeoutMs])

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  return { armed, request, disarm }
}
