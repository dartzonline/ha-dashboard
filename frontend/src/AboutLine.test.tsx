import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatReleased } from './aboutFormat'
import { AboutLine } from './AboutLine'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('AboutLine', () => {
  it('shows the version, the day it was released, and the copyright', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '1.29.0', releasedOn: '2026-11-16' }))))
    render(<AboutLine />)
    expect(await screen.findByText(/v1\.29\.0/)).toBeTruthy()
    expect(screen.getByText(/released Nov 16, 2026/)).toBeTruthy()
    expect(screen.getByText('© 2026 Dart')).toBeTruthy()
  })

  it('leaves the date out for a version with no changelog entry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '1.29.0', releasedOn: null }))))
    render(<AboutLine />)
    expect(await screen.findByText(/v1\.29\.0/)).toBeTruthy()
    expect(screen.queryByText(/released/)).toBeNull()
  })

  it('still shows the copyright when the version cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    render(<AboutLine />)
    expect(screen.getByText('© 2026 Dart')).toBeTruthy()
    expect(screen.getByText('Home Panel')).toBeTruthy()
    expect(screen.queryByText(/released/)).toBeNull()
  })

  it('formats a release day without a time zone moving it, and ignores anything else', () => {
    expect(formatReleased('2026-11-16')).toBe('Nov 16, 2026')
    expect(formatReleased('2026-01-01')).toBe('Jan 1, 2026')
    expect(formatReleased('not a date')).toBeNull()
  })
})
