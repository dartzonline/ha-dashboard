/**
 * One condition vocabulary for every weather surface in the app.
 *
 * Home Assistant weather states (`partlycloudy`, `rainy`), open-meteo's WMO labels ("slight rain
 * showers"), and free-text all describe the same handful of skies. Both the weather screen and the
 * world-clock city card map through here so a rainy Frankfurt and a rainy back garden get the same
 * tint and the same animation.
 */
export type SkyKind = 'sunny' | 'cloudy' | 'rain' | 'storm' | 'snow' | 'fog'

export interface SkyTheme {
  kind: SkyKind
  /** True when the local hour says this sky should be rendered dark. */
  night: boolean
  /** Class applied to a themed container, e.g. `sky-rain is-night`. */
  className: string
}

export function skyKind(condition: string): SkyKind {
  const value = condition.replaceAll('_', ' ').toLowerCase()
  if (/(lightning|thunder|storm|hail)/.test(value)) return 'storm'
  if (/(snow|sleet|blizzard|flurr|rime|ice)/.test(value)) return 'snow'
  if (/(rain|drizzle|shower|pour|wet)/.test(value)) return 'rain'
  if (/(fog|mist|haze|smoke|dust|sand)/.test(value)) return 'fog'
  if (/(clear|sunny|fair)/.test(value)) return 'sunny'
  if (/(partly|mainly|cloud|overcast)/.test(value)) return 'cloudy'
  return 'cloudy'
}

/**
 * @param condition free-text condition from any of the sources above
 * @param localHour 0-23 in the *place's* own time, so night in Auckland looks like night
 */
export function skyTheme(condition: string, localHour: number): SkyTheme {
  const kind = skyKind(condition)
  const night = localHour < 6 || localHour >= 20
  return { kind, night, className: `sky-${kind}${night ? ' is-night' : ''}` }
}
