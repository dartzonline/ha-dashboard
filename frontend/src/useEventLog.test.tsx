import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useEventLog } from './useEventLog'

function alert(id: number) {
  return { id, title: `Alert ${id}`, message: 'off → on', tone: 'info' as const }
}

describe('useEventLog', () => {
  it('prepends newest first', () => {
    const { result } = renderHook(() => useEventLog())
    act(() => {
      result.current.addEvent(alert(1))
      result.current.addEvent(alert(2))
    })
    expect(result.current.events.map((entry) => entry.id)).toEqual([2, 1])
    expect(result.current.events[0].at).toBeTypeOf('number')
  })

  it('ignores an alert id it has already logged', () => {
    const { result } = renderHook(() => useEventLog())
    act(() => {
      result.current.addEvent(alert(7))
      result.current.addEvent(alert(7))
    })
    expect(result.current.events).toHaveLength(1)
  })

  it('never grows past 200 entries', () => {
    const { result } = renderHook(() => useEventLog())
    act(() => {
      for (let id = 1; id <= 250; id += 1) result.current.addEvent(alert(id))
    })
    expect(result.current.events).toHaveLength(200)
    // The oldest fall off the end; the newest stay.
    expect(result.current.events[0].id).toBe(250)
    expect(result.current.events[199].id).toBe(51)
  })

  it('keeps a stable addEvent identity so callers can depend on it', () => {
    const { result, rerender } = renderHook(() => useEventLog())
    const first = result.current.addEvent
    rerender()
    expect(result.current.addEvent).toBe(first)
  })
})
