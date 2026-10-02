import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { defaultTheme, readTheme, THEME_STORAGE_KEY } from './theme'

const fixtures = vi.hoisted(() => ({
  callService: vi.fn(),
  save: vi.fn(),
  ready: true,
  entities: new Map(),
  sections: [
    { id: 'home', label: 'Home', tiles: [
      { entityId: 'light.kitchen', label: 'Kitchen', kind: 'toggle', icon: 'light' },
      { entityId: 'light.hall', label: 'Hall', kind: 'toggle', icon: 'light' },
    ] },
    { id: 'climate', label: 'Climate', tiles: [] },
    { id: 'security', label: 'Security', tiles: [] },
  ],
}))
vi.mock('./useHomeAssistant', () => ({ useHomeAssistant: () => ({ entities: fixtures.entities, health: { home_assistant: { configured: true, connected: true } }, loading: false, error: null, callService: fixtures.callService, runNightMode: vi.fn(), connection: 'live', lastMessageAt: null, authFailed: false }) }))
vi.mock('./useDashboardConfig', () => ({ editableSectionIds: new Set(['home', 'climate', 'security']), useDashboardConfig: () => ({ sections: fixtures.sections, nightModeIndoorLights: [], energyRatePerKwh: .15, customized: false, ready: fixtures.ready, error: null, save: fixtures.save, saveEnergyRate: vi.fn(), reset: vi.fn() }) }))
vi.mock('./useEntityDiscovery', () => ({ useEntityDiscovery: () => ({ proposals: [], needsReview: [], loading: false }) }))
vi.mock('./useInsights', () => ({ useInsights: () => ({ series: {}, loading: false }) }))
vi.mock('./useAutoDim', () => ({ useAutoDim: () => '' }))
vi.mock('./useSparkline', () => ({ useSparkline: () => [] }))
vi.mock('./photoLibrary', () => ({ usePhotoLibrary: () => [] }))
vi.mock('./PhotoBackdrop', () => ({ PhotoBackdrop: () => null }))
vi.mock('./TrackedAircraftBadge', () => ({ TrackedAircraftBadge: () => null }))
vi.mock('./ConnectionStatus', () => ({ ConnectionStatus: () => null }))

beforeEach(() => { window.history.replaceState(null, '', '/#/home'); window.sessionStorage.clear(); window.localStorage.clear(); fixtures.callService.mockClear(); fixtures.save.mockClear(); fixtures.ready = true })
afterEach(cleanup)

describe('dashboard shell', () => {
  it('toggles seasonal decorations without changing the selected palette', () => {
    const { container } = render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'All sections' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Halloween' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Seasonal effects' }))
    expect(readTheme()).toEqual({ ...defaultTheme, palette: 'halloween', effects: false })
    expect(document.documentElement.dataset.themeEffects).toBe('off')
    expect(container.querySelector('.seasonal-effects')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelectorAll('.haunted-lantern')).toHaveLength(2)
    const pumpkin = container.querySelector('.haunted-pumpkin') as HTMLElement
    expect(pumpkin.style.left).toBe('50%')
    fireEvent.animationIteration(pumpkin)
    expect(parseFloat(pumpkin.style.left)).toBeGreaterThanOrEqual(36)
    expect(parseFloat(pumpkin.style.left)).toBeLessThanOrEqual(64)
    expect(parseFloat(pumpkin.style.top)).toBeGreaterThanOrEqual(36)
    expect(parseFloat(pumpkin.style.top)).toBeLessThanOrEqual(64)
    expect(fixtures.callService).not.toHaveBeenCalled()
  })

  it('saves theme choices offline without enabling layout saves or calling devices', () => {
    fixtures.ready = false
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'All sections' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Modern' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Arctic' }))
    expect(readTheme()).toEqual({ style: 'modern', palette: 'arctic' })
    expect(screen.getByText('Saved on this device.')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Dashboard tiles' }))
    expect((screen.getByRole('button', { name: 'Waiting for saved layout…' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Theme' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset theme' }))
    expect(readTheme()).toEqual(defaultTheme)
    expect(fixtures.save).not.toHaveBeenCalled()
    expect(fixtures.callService).not.toHaveBeenCalled()
  })

  it('restores saved radio selections when settings opens', () => {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ style: 'retro', palette: 'ember' }))
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'All sections' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect((screen.getByRole('radio', { name: 'Retro' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: 'Ember' }) as HTMLInputElement).checked).toBe(true)
  })

  it('filters labels and entity IDs, handles empty results, and clears search', () => {
    render(<App />)
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'KITCHEN' } })
    expect(screen.getByRole('button', { name: 'Open Kitchen details' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Hall details' })).toBeNull()
    fireEvent.change(search, { target: { value: 'light.hall' } })
    expect(screen.getByRole('button', { name: 'Open Hall details' })).toBeTruthy()
    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.getByText('No matching devices')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear device search' }))
    expect(screen.getAllByRole('button', { name: /^Open .+ details$/ })).toHaveLength(2)
    expect(fixtures.callService).not.toHaveBeenCalled()
  })

  it('isolates the drawer and restores focus after Escape', () => {
    const { container } = render(<App />)
    const opener = screen.getByRole('button', { name: 'All sections' })
    opener.focus()
    fireEvent.click(opener)
    const drawer = screen.getByRole('dialog', { name: 'All sections' })
    expect(within(drawer).getByRole('button', { name: 'Climate' })).toBeTruthy()
    expect(container.querySelector('main')?.hasAttribute('inert')).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(container.querySelector('main')?.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(opener)
  })

  it('resets search when navigating through primary destinations', () => {
    render(<App />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'kitchen' } })
    const dock = screen.getByRole('navigation', { name: 'Quick navigation' })
    fireEvent.click(within(dock).getByRole('button', { name: 'Climate' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Climate' })).toBeTruthy()
    fireEvent.click(within(dock).getByRole('button', { name: 'Home' }))
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
    expect(screen.getAllByRole('button', { name: /^Open .+ details$/ })).toHaveLength(2)
    expect(fixtures.callService).not.toHaveBeenCalled()
  })
})