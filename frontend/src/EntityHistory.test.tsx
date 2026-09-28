import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EntityHistory } from './EntityHistory'
import { fetchHistory } from './history'

vi.mock('./history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./history')>()),
  fetchHistory: vi.fn(),
}))

class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => { vi.stubGlobal('ResizeObserver', NoopResizeObserver) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.mocked(fetchHistory).mockReset() })

describe('EntityHistory', () => {
  it('wraps the chart so page swipes ignore it and summarises the window', async () => {
    const now = Date.now()
    vi.mocked(fetchHistory).mockResolvedValue([[20, 22, 24].map((state, index) => ({ state: String(state), last_changed: new Date(now - (3 - index) * 3_600_000).toISOString() }))])
    const { container } = render(<EntityHistory entityId="sensor.office_temperature" unit="°C" currentState="24" />)
    expect(await screen.findByText('3 samples')).toBeTruthy()
    expect(container.querySelector('.history-plot[data-swipe-ignore]')).toBeTruthy()
  })

  it('says so when the recorder has no numeric history', async () => {
    vi.mocked(fetchHistory).mockResolvedValue([[]])
    render(<EntityHistory entityId="sensor.office_temperature" unit="°C" currentState="24" />)
    expect(await screen.findByText('No numeric history')).toBeTruthy()
  })
})
