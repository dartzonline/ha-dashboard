import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEAP_LIMIT_BYTES, REFRESH_AFTER_MS, REFRESH_MAX_AGE_MS, shouldRefresh } from './autoRefresh'
import { useAutoRefresh } from './useAutoRefresh'

const HOUR = 3600_000

describe('when the panel refreshes itself', () => {
  it('refreshes at 4 am once the page is a day old, and not before', () => {
    expect(shouldRefresh({ ageMs: REFRESH_AFTER_MS, hour: 4, idle: true })).toBe(true)
    expect(shouldRefresh({ ageMs: REFRESH_AFTER_MS, hour: 3, idle: true })).toBe(false)
    expect(shouldRefresh({ ageMs: 5 * HOUR, hour: 4, idle: true })).toBe(false)
  })

  it('never interrupts anyone: nothing happens while a sheet, the menu or search is open', () => {
    expect(shouldRefresh({ ageMs: REFRESH_MAX_AGE_MS * 2, hour: 4, heapBytes: HEAP_LIMIT_BYTES * 2, idle: false })).toBe(false)
  })

  it('has a hard age limit and a memory limit for a panel that was busy at 4 am', () => {
    expect(shouldRefresh({ ageMs: REFRESH_MAX_AGE_MS, hour: 15, idle: true })).toBe(true)
    expect(shouldRefresh({ ageMs: 2 * HOUR, hour: 15, heapBytes: HEAP_LIMIT_BYTES + 1, idle: true })).toBe(true)
    expect(shouldRefresh({ ageMs: 2 * HOUR, hour: 15, heapBytes: 40 * 1024 * 1024, idle: true })).toBe(false)
  })
})

function Probe({ idle, reload }: { idle: boolean; reload: () => void }) { useAutoRefresh(idle, reload); return null }

describe('useAutoRefresh', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }) })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('reloads once in the small hours after a long uptime, and waits while something is open', async () => {
    vi.setSystemTime(new Date(2026, 10, 15, 8, 0))
    const reload = vi.fn()
    const { rerender } = render(<Probe idle reload={reload} />)
    // Twenty hours later it is 4 am, but someone has a sheet open.
    rerender(<Probe idle={false} reload={reload} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(20 * HOUR) })
    expect(new Date().getHours()).toBe(4)
    expect(reload).not.toHaveBeenCalled()
    rerender(<Probe idle reload={reload} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000) })
    expect(reload).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000) })
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
