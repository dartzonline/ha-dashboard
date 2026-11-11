import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BurstLayer, burstVariants, useBursts } from './seasonalPlay'

afterEach(cleanup)

describe('tap reactions', () => {
  it('picks a reaction at random and draws each one', () => {
    for (const [index, variant] of burstVariants.entries()) {
      const pick = () => (index + 0.5) / burstVariants.length
      const { result, unmount } = renderHook(() => useBursts(pick))
      act(() => result.current.spawn(100, 100))
      expect(result.current.bursts[0].variant).toBe(variant)
      const { container } = render(<BurstLayer bursts={result.current.bursts} kind="leaf" />)
      const layer = container.querySelector('.seasonal-burst') as HTMLElement
      expect(layer.className).toContain(variant === 'burst' ? 'burst-burst' : `burst-${variant}`)
      expect(layer.children.length).toBeGreaterThan(0)
      unmount()
    }
  })

  it('sends the critter away from the nearer edge', () => {
    const { result } = renderHook(() => useBursts(() => 0.99))
    act(() => result.current.spawn(10, 100))
    expect(result.current.bursts[0].dir).toBe(-1)
  })
})
