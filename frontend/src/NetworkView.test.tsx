import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearCachedJson } from './cachedFetch'
import { NetworkView } from './NetworkView'
import type { HAEntity } from './types'

afterEach(() => {
  cleanup()
  clearCachedJson()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function entity(entity_id: string, state: string): HAEntity {
  return { entity_id, state, attributes: {}, last_changed: '', last_updated: '' } as HAEntity
}

const network = {
  hours: 24,
  points: [
    { time: '2026-09-28T10:00:00Z', downloadMbps: 300, uploadMbps: 20, devices: 30 },
    { time: '2026-09-28T11:00:00Z', downloadMbps: 280, uploadMbps: 22, devices: 32 },
  ],
  download: { average: 290, min: 280, max: 300 },
  upload: { average: 21, min: 20, max: 22 },
  devices: { average: 31, min: 30, max: 32, now: 32, tracked: 40 },
}

const clientsBody = {
  hours: 24,
  onlineCount: 1,
  trackedCount: 2,
  clients: [{ entityId: 'device_tracker.phone', name: 'Phone', ip: '192.168.1.9', mac: null, hostname: null, home: true, since: null }],
  events: [],
  router: { firmwareInstalled: 'V1', firmwareLatest: 'V1', updateAvailable: false },
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
}

function renderView(entities: HAEntity[] = [entity('binary_sensor.cbr750_gateway_wan_status', 'on')], onService = vi.fn(() => Promise.resolve())) {
  render(<NetworkView entities={new Map(entities.map((item) => [item.entity_id, item]))} onService={onService} onExpand={vi.fn()} />)
  return onService
}

describe('NetworkView', () => {
  it('titles the page from the WAN sensor and exposes the range tabs as a tablist', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => ok(String(input).includes('clients') ? clientsBody : network)))
    renderView()
    expect(screen.getByRole('heading', { name: 'Internet online' })).toBeTruthy()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['6h', '24h', '3d', '7d'])
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tabs[1].id)

    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    await waitFor(() => expect(screen.getByRole('tab', { name: '3d' }).getAttribute('aria-selected')).toBe('true'))
    expect(await screen.findByText('Phone')).toBeTruthy()
  })

  it('offers a retry when the device list fails, and refetches on tap', async () => {
    let clientsCalls = 0
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (!String(input).includes('clients')) return ok(network)
      clientsCalls += 1
      return clientsCalls === 1
        ? Promise.resolve({ ok: false, status: 500, statusText: 'Server error', json: () => Promise.resolve({}), text: () => Promise.resolve('') } as Response)
        : ok(clientsBody)
    }))
    renderView()
    const retries = await screen.findAllByRole('button', { name: 'Retry' })
    fireEvent.click(retries[0])
    expect(await screen.findByText('Phone')).toBeTruthy()
    expect(clientsCalls).toBe(2)
  })

  it('needs two taps to restart the router', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => ok(String(input).includes('clients') ? clientsBody : network)))
    const onService = renderView([
      entity('binary_sensor.cbr750_gateway_wan_status', 'on'),
      entity('button.cbr750_restart', 'unknown'),
    ])
    fireEvent.click(screen.getByRole('button', { name: /Restart router/ }))
    expect(onService).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Tap again to restart/ }))
    await waitFor(() => expect(onService).toHaveBeenCalledWith('button', 'press', { entity_id: 'button.cbr750_restart' }))
  })
})
