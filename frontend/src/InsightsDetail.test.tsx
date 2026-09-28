import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchHistory } from './history'
import { InsightsDetail } from './InsightsDetail'
import type { InsightDetailConfig } from './insightDetails'

vi.mock('./history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./history')>()),
  fetchHistory: vi.fn(),
}))

class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => { vi.stubGlobal('ResizeObserver', NoopResizeObserver) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.mocked(fetchHistory).mockReset() })

const config: InsightDetailConfig = {
  id: 'washer', title: 'Washer', subtitle: 'Cycle status', value: 'Idle', unit: '', hours: 24, chart: 'line',
  series: [{ entityId: 'sensor.washer_current_status', label: 'Washer status', color: '#000000' }],
  explanation: 'Text state.', factors: [{ label: 'Status', value: 'Idle', tone: 'good' }],
}

describe('InsightsDetail', () => {
  it('is a labelled modal sheet that focuses its close button and closes on Escape', async () => {
    vi.mocked(fetchHistory).mockResolvedValue([[{ state: 'spin_cycle', last_changed: new Date().toISOString() }]])
    const onClose = vi.fn()
    render(<InsightsDetail config={config} onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: 'Washer' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByRole('button', { name: 'Close details' }).hasAttribute('data-autofocus')).toBe(true)
    // Text states are sentence-cased in code rather than by CSS.
    expect(await screen.findByText('Spin cycle')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
