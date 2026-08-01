import { useEffect, useRef, useState } from 'react'
import './Screensaver.css'

const IDLE_TIMEOUT_MS = 5 * 60 * 1000
const DRIFT_INTERVAL_MS = 60 * 1000
const DRIFT_RANGE_PX = 20
const DISMISS_EVENTS = ['pointerdown', 'touchstart', 'keydown'] as const

function randomOffset() {
  return {
    x: Math.round((Math.random() * 2 - 1) * DRIFT_RANGE_PX),
    y: Math.round((Math.random() * 2 - 1) * DRIFT_RANGE_PX),
  }
}

export function Screensaver() {
  const [visible, setVisible] = useState(false)
  const [now, setNow] = useState(new Date())
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const idleTimerRef = useRef<number | undefined>(undefined)

  // Idle timer: show the overlay after IDLE_TIMEOUT_MS of no activity, and
  // instantly dismiss it (then restart the timer) on the same activity events.
  useEffect(() => {
    const armIdleTimer = () => {
      window.clearTimeout(idleTimerRef.current)
      idleTimerRef.current = window.setTimeout(() => {
        // Refresh the clock and drift offset the moment the overlay appears,
        // so it never opens showing a stale time or a stale position.
        setNow(new Date())
        setOffset(randomOffset())
        setVisible(true)
      }, IDLE_TIMEOUT_MS)
    }

    const handleActivity = () => {
      setVisible(false)
      armIdleTimer()
    }

    armIdleTimer()
    for (const eventName of DISMISS_EVENTS) {
      window.addEventListener(eventName, handleActivity)
    }

    return () => {
      window.clearTimeout(idleTimerRef.current)
      for (const eventName of DISMISS_EVENTS) {
        window.removeEventListener(eventName, handleActivity)
      }
    }
  }, [])

  // Tick the clock every second, but only while the overlay is actually shown.
  useEffect(() => {
    if (!visible) return
    const timer = window.setInterval(() => setNow(new Date()), 1_000)
    return () => window.clearInterval(timer)
  }, [visible])

  // Burn-in mitigation: nudge the clock block to a new small random offset
  // periodically while showing; CSS transition animates the move smoothly.
  useEffect(() => {
    if (!visible) return
    const timer = window.setInterval(() => setOffset(randomOffset()), DRIFT_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [visible])

  return (
    <div className={`screensaver${visible ? ' screensaver--visible' : ''}`} aria-hidden={!visible}>
      <div
        className="screensaver-clock"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      >
        <strong>{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</strong>
        <p>{now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      </div>
    </div>
  )
}
