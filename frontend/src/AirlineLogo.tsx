import { useState } from 'react'

/**
 * Airline tail logos, sourced from Jxck-S/airline-logos. Three repositories are tried in turn
 * because no single set covers every operator — a miss falls through to the next, then to initials.
 *
 * Lives in its own module rather than inside FlightsView because the header badge needs it too,
 * and FlightsView is lazy-loaded: the header must not have to pull the whole flights bundle
 * (and its Recharts dependency) just to draw a 20px logo.
 */
const LOGO_SOURCES = [
  (code: string) => `https://raw.githubusercontent.com/Jxck-S/airline-logos/main/custom_logos/${code}.png`,
  (code: string) => `https://raw.githubusercontent.com/Jxck-S/airline-logos/main/radarbox_logos/${code}.png`,
  (code: string) => `https://raw.githubusercontent.com/Jxck-S/airline-logos/main/flightaware_logos/${code}.png`,
]

export function AirlineLogo({ code, className = 'airline-logo' }: { code: string | null; className?: string }) {
  // Reset the attempt counter when the airline code changes by adjusting state during render
  // (the React-recommended alternative to an effect that only mirrors a prop).
  const [state, setState] = useState({ code, attempt: 0 })
  if (state.code !== code) {
    setState({ code, attempt: 0 })
  }

  const initials = code ? code.slice(0, 2).toUpperCase() : '–'

  if (!code || state.attempt >= LOGO_SOURCES.length) {
    return <span className={`${className} airline-logo-fallback`} aria-hidden="true">{initials}</span>
  }

  return (
    <img
      className={className}
      src={LOGO_SOURCES[state.attempt](code)}
      alt=""
      aria-hidden="true"
      onError={() => setState((current) => ({ ...current, attempt: current.attempt + 1 }))}
    />
  )
}
