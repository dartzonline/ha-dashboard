import type { SkyTheme } from './weatherTheme'
import './WeatherAtmosphere.css'

interface WeatherAtmosphereProps {
  theme: SkyTheme
}

/**
 * Purely decorative animated backdrop for a themed weather surface. Everything is CSS-driven and
 * `aria-hidden`; the numbers beside it carry the actual information.
 */
export function WeatherAtmosphere({ theme }: WeatherAtmosphereProps) {
  const { kind, night } = theme

  return (
    <div className={`sky-atmosphere ${theme.className}`} aria-hidden="true">
      {kind === 'sunny' && !night && <span className="sky-sun"><i /></span>}
      {kind === 'sunny' && night && (
        <>
          <span className="sky-moon" />
          {[...Array(9).keys()].map((index) => <span key={index} className={`sky-star star-${index}`} />)}
        </>
      )}

      {(kind === 'cloudy' || kind === 'rain' || kind === 'storm' || kind === 'snow') && (
        <>
          <span className="sky-cloud cloud-one" />
          <span className="sky-cloud cloud-two" />
          <span className="sky-cloud cloud-three" />
        </>
      )}

      {(kind === 'rain' || kind === 'storm') && (
        [...Array(10).keys()].map((index) => <span key={index} className={`sky-rain drop-${index}`} />)
      )}

      {kind === 'storm' && <span className="sky-flash" />}

      {kind === 'snow' && (
        [...Array(10).keys()].map((index) => <span key={index} className={`sky-flake flake-${index}`} />)
      )}

      {kind === 'fog' && (
        <>
          <span className="sky-fog fog-one" />
          <span className="sky-fog fog-two" />
          <span className="sky-fog fog-three" />
        </>
      )}
    </div>
  )
}
