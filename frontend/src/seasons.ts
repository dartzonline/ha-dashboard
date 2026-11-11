import type { HAEntity } from './types'

export type SeasonalPalette = 'halloween' | 'fall' | 'holidays'

/** October is Halloween, November is Fall, and Holidays runs from December 1 through Epiphany (January 6). */
export function seasonForDate(date: Date): SeasonalPalette | null {
  const month = date.getMonth()
  const day = date.getDate()
  if (month === 9) return 'halloween'
  if (month === 10) return 'fall'
  if (month === 11 || (month === 0 && day <= 6)) return 'holidays'
  return null
}

/** Shown from December 1; a countdown in November felt too early. */
export function christmasCountdown(date: Date): string | null {
  if (date.getMonth() !== 11 || date.getDate() > 25) return null
  const day = date.getDate()
  if (day === 25) return 'Merry Christmas'
  if (day === 24) return 'Christmas Eve · 1 sleep to go'
  return `${25 - day} sleeps to Christmas`
}

export interface SeasonalWeather {
  tempC: number | null
  windKmh: number
  /** Where the wind blows *towards* on screen: -1 is leftwards, 1 rightwards. */
  windX: number
  snowing: boolean
  raining: boolean
  /** Home Assistant's condition word: 'rainy', 'fog', 'clear-night', 'lightning-rainy'… */
  condition: string | null
}

const CALM: SeasonalWeather = { tempC: null, windKmh: 0, windX: 0, snowing: false, raining: false, condition: null }

function toKmh(speed: number, unit: unknown): number {
  if (unit === 'mph') return speed * 1.609
  if (unit === 'm/s') return speed * 3.6
  if (unit === 'kn') return speed * 1.852
  return speed
}

/** Reads the forecast entity the Weather page already uses. Anything missing reads as calm. */
export function seasonalWeather(entities: Map<string, HAEntity>): SeasonalWeather {
  const weather = entities.get('weather.forecast_home') ?? Array.from(entities.values()).find((entity) => entity.entity_id.startsWith('weather.'))
  if (!weather) return CALM
  const { temperature, temperature_unit: tempUnit, wind_speed: windSpeed, wind_speed_unit: windUnit, wind_bearing: bearing } = weather.attributes
  const rawTemp = typeof temperature === 'number' ? temperature : null
  const tempC = rawTemp === null ? null : tempUnit === '°F' ? (rawTemp - 32) * 5 / 9 : rawTemp
  const windKmh = typeof windSpeed === 'number' ? toKmh(windSpeed, windUnit) : 0
  // Meteorological bearing is where the wind comes *from*; a westerly (270°) blows to the right.
  const windX = typeof bearing === 'number' ? -Math.sin((bearing * Math.PI) / 180) : 0
  const condition = weather.state
  return {
    tempC,
    windKmh,
    windX,
    snowing: condition === 'snowy' || condition === 'snowy-rainy',
    raining: condition === 'rainy' || condition === 'pouring' || condition === 'lightning-rainy',
    condition: condition || null,
  }
}
