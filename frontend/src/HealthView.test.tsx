import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearCachedJson } from './cachedFetch'
import { HealthView } from './HealthView'

afterEach(() => {
  cleanup()
  clearCachedJson()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const registry = { total: 1, live: 1, unavailable: 0, duplicates: [], orphans: [], orphanCount: 0 }

function healthPayload(leftOn: string[]) {
  return {
    items: leftOn.map((entityId) => ({ severity: 'warning', category: 'light', title: entityId, detail: 'On for 3h 00m', entityId })),
    counts: { critical: 0, warning: leftOn.length, info: 0 },
    registry,
    leftOn,
  }
}

describe('HealthView turn off what is left on', () => {
  it('asks first, then switches off and refreshes the list', async () => {
    let leftOn = ['light.kitchen', 'switch.office_space_heater']
    const posts: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('actions/turn-off-left-on')) {
        posts.push(JSON.parse(String(init?.body)))
        const turnedOff = leftOn
        leftOn = []
        return new Response(JSON.stringify({ status: 'completed', turnedOff, failures: [] }))
      }
      if (url.includes('insights/health')) return new Response(JSON.stringify(healthPayload(leftOn)))
      throw new Error(`Unexpected fetch: ${url}`)
    }))

    render(<HealthView onExpand={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off 2 things left on' }))
    expect(posts).toEqual([])
    expect(screen.getByText(/Doors, locks and garages are not touched/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    expect(await screen.findByText('Switched off 2 things.')).toBeTruthy()
    expect(posts).toEqual([{ confirm: true }])
    await waitFor(() => expect(screen.queryByRole('button', { name: /left on/ })).toBeNull())
  })

  it('offers nothing when nothing is left on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(healthPayload([])))))
    render(<HealthView onExpand={vi.fn()} />)
    expect(await screen.findByText('All clear')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Things left on' })).toBeNull()
  })
})
