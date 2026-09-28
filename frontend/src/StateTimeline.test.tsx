import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchHistory } from './history'
import { StateTimeline } from './StateTimeline'

vi.mock('./history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./history')>()),
  fetchHistory: vi.fn(),
}))

afterEach(() => { cleanup(); vi.mocked(fetchHistory).mockReset() })

function records(...states: string[]) {
  const start = Date.now() - 6 * 3_600_000
  return [states.map((state, index) => ({ state, last_changed: new Date(start + index * 3_600_000).toISOString() }))]
}

const sentence = (state: string) => state.charAt(0).toUpperCase() + state.slice(1).replaceAll('_', ' ')

describe('StateTimeline', () => {
  it('draws an on/off entity as one series hue against a resting fill, with a legend', async () => {
    vi.mocked(fetchHistory).mockResolvedValue(records('off', 'on', 'off', 'on'))
    const { container } = render(<StateTimeline entityId="light.kitchen" currentState="on" formatState={sentence} />)
    expect(await screen.findByText('3 changes')).toBeTruthy()
    const legend = container.querySelector('.chart-legend') as HTMLElement
    expect(within(legend).getByText('On')).toBeTruthy()
    expect(within(legend).getByText('Off')).toBeTruthy()
    const fills = Array.from(container.querySelectorAll<HTMLElement>('.timeline-segment')).map((segment) => segment.style.getPropertyValue('--segment'))
    expect(fills[1]).toBe('var(--chart-1)')
    expect(fills[0]).not.toContain('--chart-')
    expect(container.querySelector('[data-swipe-ignore]')).toBeTruthy()
  })

  it('colours categorical states in a fixed order by state name', async () => {
    vi.mocked(fetchHistory).mockResolvedValue(records('docked', 'cleaning', 'returning', 'docked'))
    const { container } = render(<StateTimeline entityId="vacuum.robot" currentState="docked" formatState={sentence} />)
    await screen.findByText('3 changes')
    const fills = Array.from(container.querySelectorAll<HTMLElement>('.timeline-segment')).map((segment) => segment.style.getPropertyValue('--segment'))
    // Alphabetical: cleaning, docked, returning.
    expect(fills).toEqual(['var(--chart-2)', 'var(--chart-1)', 'var(--chart-3)', 'var(--chart-2)'])
  })

  it('shows an empty state when nothing was recorded', async () => {
    vi.mocked(fetchHistory).mockResolvedValue([[]])
    render(<StateTimeline entityId="lock.front" currentState="locked" formatState={sentence} />)
    expect(await screen.findByText('No recorded activity')).toBeTruthy()
  })
})
