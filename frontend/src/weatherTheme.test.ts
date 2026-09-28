import { describe, expect, it } from 'vitest'
import { skyKind, skyTheme } from './weatherTheme'

describe('skyKind', () => {
  it.each([
    ['sunny', 'sunny'],
    ['clear-night', 'sunny'],
    ['partlycloudy', 'cloudy'],
    ['Overcast', 'cloudy'],
    ['rainy', 'rain'],
    ['slight rain showers', 'rain'],
    ['drizzle', 'rain'],
    ['lightning-rainy', 'storm'],
    ['Thunderstorm with hail', 'storm'],
    ['snowy-rainy', 'snow'],
    ['sleet', 'snow'],
    ['fog', 'fog'],
    ['Depositing rime fog', 'snow'],
    ['exceptional', 'cloudy'],
    ['', 'cloudy'],
  ])('maps "%s" to %s', (condition, expected) => {
    expect(skyKind(condition)).toBe(expected)
  })

  it('ranks storm above rain and snow above rain when a phrase mentions both', () => {
    expect(skyKind('rain and thunder')).toBe('storm')
    expect(skyKind('snow showers')).toBe('snow')
  })
})

describe('skyTheme', () => {
  it('reads night from the local hour, not the browser clock', () => {
    expect(skyTheme('rainy', 3)).toEqual({ kind: 'rain', night: true, className: 'sky-rain is-night' })
    expect(skyTheme('rainy', 12)).toEqual({ kind: 'rain', night: false, className: 'sky-rain' })
    expect(skyTheme('sunny', 20).night).toBe(true)
    expect(skyTheme('sunny', 6).night).toBe(false)
  })
})
