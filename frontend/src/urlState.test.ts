import { afterEach, describe, expect, it } from 'vitest'
import { clampSlide, parseShellHash, readRotationHold, shellHash, writeRotationHold } from './urlState'

afterEach(() => window.sessionStorage.clear())

describe('shell URL state', () => {
  it('reads a section and a 1-based slide from the hash', () => {
    expect(parseShellHash('#/climate')).toEqual({ section: 'climate', slide: 0 })
    expect(parseShellHash('#/insights/2')).toEqual({ section: 'insights', slide: 1 })
  })

  it('ignores anything that is not a shell hash', () => {
    expect(parseShellHash('')).toEqual({ section: null, slide: 0 })
    expect(parseShellHash('#top')).toEqual({ section: null, slide: 0 })
    expect(parseShellHash('#/weather/0')).toEqual({ section: 'weather', slide: 0 })
  })

  it('round-trips through shellHash, leaving slide 1 implicit', () => {
    expect(shellHash('home')).toBe('#/home')
    expect(shellHash('insights', 0)).toBe('#/insights')
    expect(shellHash('insights', 3)).toBe('#/insights/4')
    expect(parseShellHash(shellHash('flights', 2))).toEqual({ section: 'flights', slide: 2 })
  })

  it('clamps a slide from an old URL to the slides that exist', () => {
    expect(clampSlide(9, 4)).toBe(3)
    expect(clampSlide(-1, 4)).toBe(0)
    expect(clampSlide(2, 0)).toBe(0)
  })

  it('remembers a deliberate rotation hold for the session only', () => {
    expect(readRotationHold()).toBe(false)
    writeRotationHold(true)
    expect(readRotationHold()).toBe(true)
    writeRotationHold(false)
    expect(readRotationHold()).toBe(false)
  })
})
