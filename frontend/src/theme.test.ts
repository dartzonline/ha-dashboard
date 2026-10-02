import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, defaultTheme, readTheme, saveTheme, THEME_STORAGE_KEY, themePalettes, themeStyles } from './theme'

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  applyTheme(defaultTheme)
})

describe('theme preferences', () => {
  it('keeps text and semantic status colors readable on raised panels', () => {
    function luminance(hex: string) {
      const channels = [1, 3, 5].map((offset) => {
        const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
      })
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
    }
    for (const palette of Object.values(themePalettes)) {
      for (const color of [palette.text, palette.muted, palette.muted2, palette.accent, '#7fd1a8', '#e6b47a', '#f09090']) {
        expect((luminance(color) + .05) / (luminance(palette.raised) + .05), `${palette.label}: ${color}`).toBeGreaterThanOrEqual(4.5)
      }
      expect((luminance(palette.accent) + .05) / (luminance(palette.ink) + .05)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('defaults to the current retro-modern phosphor theme', () => {
    expect(readTheme()).toEqual(defaultTheme)
  })

  it('persists seasonal effects and defaults old preferences to enabled', () => {
    saveTheme({ style: 'hybrid', palette: 'holidays', effects: false })
    expect(readTheme().effects).toBe(false)
    expect(document.documentElement.dataset.themeEffects).toBe('off')
    saveTheme({ style: 'retro', palette: 'halloween' })
    expect(document.documentElement.dataset.themeEffects).toBe('on')
  })

  it('persists and applies every style and palette combination', () => {
    for (const style of themeStyles) {
      for (const palette of Object.keys(themePalettes) as Array<keyof typeof themePalettes>) {
        const theme = { style, palette }
        expect(saveTheme(theme)).toBe(true)
        expect(readTheme()).toEqual(theme)
        expect(document.documentElement.dataset.themeStyle).toBe(style)
        expect(document.documentElement.style.getPropertyValue('--accent')).toBe(themePalettes[palette].accent)
        expect(document.documentElement.style.getPropertyValue('--surface-solid')).toBe(themePalettes[palette].panel)
      }
    }
  })

  it('rejects malformed and unknown saved values', () => {
    for (const value of ['invalid', 'null', '42', '{"style":"unknown","palette":"__proto__"}']) {
      localStorage.setItem(THEME_STORAGE_KEY, value)
      expect(readTheme()).toEqual(defaultTheme)
    }
  })

  it('keeps the theme usable when storage is blocked', () => {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(defaultTheme))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(saveTheme({ style: 'modern', palette: 'arctic' })).toBe(false)
    expect(readTheme()).toEqual({ style: 'modern', palette: 'arctic' })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readTheme()).toEqual({ style: 'modern', palette: 'arctic' })
    expect(document.documentElement.dataset.themePalette).toBe('arctic')
  })
})