import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorldTimeMap } from './WorldTimeMap'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const now = new Date('2026-09-28T15:00:00Z')

function mapSurface() {
  const surface = screen.getByRole('button', { name: 'Read the local time at a point on the map' })
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) })
  return surface
}

describe('WorldTimeMap', () => {
  it('opts the map out of page swipes', () => {
    render(<WorldTimeMap now={now} />)
    expect(mapSurface().hasAttribute('data-swipe-ignore')).toBe(true)
  })

  it('drops a pin on a tap', () => {
    render(<WorldTimeMap now={now} />)
    const surface = mapSurface()
    fireEvent.pointerDown(surface, { clientX: 520, clientY: 140 })
    fireEvent.pointerUp(surface, { clientX: 524, clientY: 143 })
    expect(screen.getByRole('button', { name: /Clear pin/ })).toBeTruthy()
  })

  it('ignores a pointer that travelled more than 10px, since that was a swipe', () => {
    render(<WorldTimeMap now={now} />)
    const surface = mapSurface()
    fireEvent.pointerDown(surface, { clientX: 520, clientY: 140 })
    fireEvent.pointerUp(surface, { clientX: 620, clientY: 142 })
    expect(screen.queryByRole('button', { name: /Clear pin/ })).toBeNull()
  })

  it('opens the city weather sheet as a labelled modal dialog that Escape closes', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
    render(<WorldTimeMap now={now} />)
    fireEvent.click(screen.getByTitle('Show current weather in Frankfurt'))
    const dialog = screen.getByRole('dialog', { name: 'Frankfurt' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.closest('[data-swipe-ignore]')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
