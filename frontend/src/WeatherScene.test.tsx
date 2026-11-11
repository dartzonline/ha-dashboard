import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { weatherEffects, WeatherScene } from './WeatherScene'
import type { SeasonalWeather } from './seasons'

afterEach(cleanup)

const weather = (condition: string | null, extra: Partial<SeasonalWeather> = {}): SeasonalWeather => ({
  tempC: 12, windKmh: 5, windX: 0, snowing: false, raining: false, condition, ...extra,
})

describe('weatherEffects', () => {
  it('maps each condition to its effects', () => {
    expect(weatherEffects(weather('rainy'), 9)).toMatchObject({ rain: true, pouring: false, lightning: false })
    expect(weatherEffects(weather('pouring'), 9)).toMatchObject({ rain: true, pouring: true })
    expect(weatherEffects(weather('lightning-rainy'), 9)).toMatchObject({ rain: true, lightning: true })
    expect(weatherEffects(weather('fog'), 9).fog).toBe(true)
    expect(weatherEffects(weather('snowy'), 0).snow).toBe(true)
    expect(weatherEffects(weather('sunny', { tempC: 33 }), 6)).toMatchObject({ sunny: true, hot: true })
    expect(weatherEffects(weather('cloudy'), 9).clouds).toBe(true)
  })

  it('treats strong wind as windy whatever the sky says', () => {
    expect(weatherEffects(weather('sunny', { windKmh: 40 }), 9).windy).toBe(true)
  })

  it('brings fireflies only to warm summer nights and blossom only to dry spring days', () => {
    expect(weatherEffects(weather('clear-night', { tempC: 20 }), 6).fireflies).toBe(true)
    expect(weatherEffects(weather('clear-night', { tempC: 20 }), 10).fireflies).toBe(false)
    expect(weatherEffects(weather('sunny'), 3).blossoms).toBe(true)
    expect(weatherEffects(weather('rainy'), 3).blossoms).toBe(false)
  })
})

describe('WeatherScene', () => {
  it('draws rain for rainy weather and stars for a clear night', () => {
    const { container, rerender } = render(<WeatherScene weather={weather('rainy', { windKmh: 40, windX: 1 })} month={9} />)
    expect(container.querySelectorAll('.wx-rain span').length).toBeGreaterThanOrEqual(60)
    expect(container.querySelector('.weather-scene')?.getAttribute('style')).toContain('--rain-lean: 20deg')
    rerender(<WeatherScene weather={weather('clear-night')} month={9} />)
    expect(container.querySelector('.wx-rain')).toBeNull()
    expect(container.querySelectorAll('.wx-stars span').length).toBeGreaterThan(40)
  })

  it('draws nothing extra on a plain day', () => {
    const { container } = render(<WeatherScene weather={weather('partlycloudy')} month={9} />)
    expect(container.querySelector('.wx-clouds')).toBeTruthy()
    expect(container.querySelector('.wx-rain, .wx-snow, .wx-fog, .wx-stars')).toBeNull()
  })
})
