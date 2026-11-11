import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MorningRunCard } from './MorningRunCard'
import { ReplaceNow } from './ReplaceNow'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('MorningRunCard', () => {
  it('shows the pre-departure checks', () => {
    render(<MorningRunCard status={{ phase: 'before', checks: [
      { id: 'car-lock', ok: false, label: 'Car unlocked' }, { id: 'car-range', ok: true, label: 'Range 549 mi' },
    ] }} onChanged={vi.fn()} />)
    expect(screen.getByText('1 to check')).toBeTruthy()
    expect(screen.getByText('Car unlocked')).toBeTruthy()
  })

  it('lists what was left behind and secures the house after a confirm', async () => {
    const posts: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ secured: ['lock.patio_door', 'light.kitchen'], failures: [] }))
    }))
    const changed = vi.fn()
    render(<MorningRunCard status={{ phase: 'out', departedAt: new Date(2026, 10, 11, 8, 14).toISOString(), canSecure: true,
      leftBehind: [{ entityId: 'lock.patio_door', label: 'Patio Door unlocked', fixable: true }, { entityId: 'light.kitchen', label: 'Kitchen on', fixable: true }] }} onChanged={changed} />)
    expect(screen.getByText('2 left behind')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Secure the house' }))
    expect(posts).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Secure' }))
    expect(await screen.findByText('Secured 2 things.')).toBeTruthy()
    expect(posts).toEqual([{ confirm: true }])
    expect(changed).toHaveBeenCalled()
  })

  it('stays out of the way outside a run', () => {
    const { container } = render(<MorningRunCard status={{ phase: null }} onChanged={vi.fn()} />)
    expect(container.textContent).toBe('')
  })
})

describe('ReplaceNow', () => {
  it('adds a refill to the shopping list, but not a cleaning job', async () => {
    const posts: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ status: 'added' }))
    }))
    render(<ReplaceNow items={[
      { id: 'f', kind: 'consumable', title: 'Refrigerator Water filter', detail: '0% left', severity: 'critical', buy: 'Refrigerator Water filter' },
      { id: 'c', kind: 'clean', title: 'Clean: Roborock Sensor', detail: 'Overdue by 60 h', severity: 'critical', buy: null },
      { id: 's', kind: 'fault', title: 'Salt sensor not reading', detail: 'The 0% is not real.', severity: 'warning', buy: null },
    ]} />)
    expect(screen.getAllByRole('button', { name: /Add to list/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /Add to list/ }))
    expect(await screen.findByText('On the list')).toBeTruthy()
    expect(posts).toEqual([{ item: 'Refrigerator Water filter' }])
  })
})
