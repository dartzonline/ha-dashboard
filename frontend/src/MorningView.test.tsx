import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { greeting, MorningView, overnightEntries, skyFor } from './MorningView'
import { iso, morningBrief } from './morningBrief.fixture'

afterEach(cleanup)

const NOW = new Date(2026, 11, 13, 7, 30)
describe('MorningView', () => {
  it('opens on today: greeting, sky and what to do today', () => {
    render(<MorningView brief={morningBrief()} failed={false} now={NOW} slide={0} onSelectSlide={vi.fn()} onRetry={vi.fn()} />)
    expect(screen.getByText('Good morning')).toBeTruthy()
    expect(screen.getByText(/12 sleeps to Christmas/)).toBeTruthy()
    expect(screen.getByText('41°F')).toBeTruthy()
    expect(screen.getByText('Windy today: gusts to 40 mph around 3 pm')).toBeTruthy()
    expect(screen.queryByText('Heavy snow tomorrow: 4 in')).toBeNull()
  })

  it('lists last night: what was open, for how long, and what house watch switched off', () => {
    render(<MorningView brief={morningBrief()} failed={false} now={NOW} slide={1} onSelectSlide={vi.fn()} onRetry={vi.fn()} />)
    expect(screen.getByText('Garage door')).toBeTruthy()
    expect(screen.getByText(/40m, 10:10/)).toBeTruthy()
    expect(screen.queryByText('Den lamp')).toBeNull()
    expect(screen.getByText('Porch light')).toBeTruthy()
    expect(screen.getByText('Everything is closed, locked and off.')).toBeTruthy()
  })

  it('says so when the night was quiet', () => {
    render(<MorningView brief={morningBrief({ journal: [], recentActions: [] })} failed={false} now={NOW} slide={1} onSelectSlide={vi.fn()} onRetry={vi.fn()} />)
    expect(screen.getByText(/A quiet night/)).toBeTruthy()
  })

  it('looks ahead: the next days and what to prepare for', () => {
    const select = vi.fn()
    render(<MorningView brief={morningBrief()} failed={false} now={NOW} slide={2} onSelectSlide={select} onRetry={vi.fn()} />)
    expect(screen.getByText('Tomorrow')).toBeTruthy()
    expect(screen.getByText('Heavy snow tomorrow: 4 in')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Today' }))
    expect(select).toHaveBeenCalledWith(0)
  })
})

describe('morning helpers', () => {
  it('greets by the hour', () => {
    expect(greeting(new Date(2026, 0, 1, 8))).toBe('Good morning')
    expect(greeting(new Date(2026, 0, 1, 14))).toBe('Good afternoon')
    expect(greeting(new Date(2026, 0, 1, 19))).toBe('Good evening')
  })

  it('reads WMO codes', () => {
    expect(skyFor(0).label).toBe('Clear')
    expect(skyFor(73).label).toBe('Snow')
    expect(skyFor(95).label).toBe('Thunderstorms')
  })

  it('keeps anything that overlapped last night, including what is still going', () => {
    const entries = morningBrief().journal
    const ongoing = { ...entries[1], startedAt: iso(13, 6), endedAt: null, ongoing: true }
    expect(overnightEntries([...entries, ongoing], NOW).map((entry) => entry.name)).toEqual(['Garage door', 'Den lamp'])
  })
})
