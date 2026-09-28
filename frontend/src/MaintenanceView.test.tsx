import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearCachedJson } from './cachedFetch'
import { MaintenanceView } from './MaintenanceView'

afterEach(() => {
  cleanup()
  clearCachedJson()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function update(overrides: Record<string, unknown> = {}) {
  return {
    entityId: 'update.esphome_garage_firmware',
    name: 'Garage ESPHome',
    installedVersion: '2026.7.0',
    latestVersion: '2026.8.0',
    releaseSummary: null,
    releaseUrl: null,
    canInstall: true,
    inProgress: false,
    progressPercent: null,
    ...overrides,
  }
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    consumables: [],
    salt: null,
    garage: null,
    faults: [],
    appliances: [],
    updates: [],
    counts: { critical: 0, warning: 0, ok: 0 },
    ...overrides,
  }
}

function mockMaintenance(body: unknown) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (!url.includes('insights/maintenance')) throw new Error(`Unexpected fetch: ${url}`)
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  })
}

describe('MaintenanceView loading', () => {
  it('fetches exactly once after the initial load, with no response-triggered cascade', async () => {
    // The `updates` array is new on every response; depending on it re-ran the polling effect,
    // which fetched again, which produced a new array... one request became a tight loop.
    const fetchMock = mockMaintenance(payload({ updates: [update()] }))
    vi.stubGlobal('fetch', fetchMock)
    render(<MaintenanceView onExpand={() => {}} onService={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Garage ESPHome')).toBeTruthy())
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('re-reads after a successful install so the progress shows, and explains a refused one', async () => {
    const onService = vi.fn().mockRejectedValue(new Error('Home Assistant is offline'))
    vi.stubGlobal('fetch', mockMaintenance(payload({ updates: [update()] })))
    render(<MaintenanceView onExpand={() => {}} onService={onService} />)

    await waitFor(() => expect(screen.getByText('Install')).toBeTruthy())
    fireEvent.click(screen.getByText('Install'))
    await waitFor(() => expect(screen.getByText(/Could not start the Garage ESPHome update — Home Assistant is offline/)).toBeTruthy())
  })
})

describe('MaintenanceView updates', () => {
  it('lists a pending update with its version change', async () => {
    vi.stubGlobal('fetch', mockMaintenance(payload({ updates: [update()] })))
    render(<MaintenanceView onExpand={() => {}} onService={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Garage ESPHome')).toBeTruthy())
    expect(screen.getByText(/2026\.7\.0 → 2026\.8\.0/)).toBeTruthy()
    expect(screen.getByText(/1 update available/)).toBeTruthy()
  })

  it('installs a non-disruptive update without asking for confirmation', async () => {
    const onService = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('fetch', mockMaintenance(payload({ updates: [update()] })))
    render(<MaintenanceView onExpand={() => {}} onService={onService} />)

    await waitFor(() => expect(screen.getByText('Install')).toBeTruthy())
    fireEvent.click(screen.getByText('Install'))

    await waitFor(() => expect(onService).toHaveBeenCalledWith('update', 'install', { entity_id: 'update.esphome_garage_firmware' }))
    // A non-disruptive update installs on the first tap.
  })

  it('asks for confirmation before installing a Home Assistant core/supervisor update', async () => {
    const onService = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('fetch', mockMaintenance(payload({
      updates: [update({ entityId: 'update.home_assistant_core_update', name: 'Home Assistant Core' })],
    })))
    render(<MaintenanceView onExpand={() => {}} onService={onService} />)

    await waitFor(() => expect(screen.getByText('Install')).toBeTruthy())
    fireEvent.click(screen.getByText('Install'))

    // One tap only arms it: the install must not have been sent, and the warning is shown.
    expect(screen.getByText('Tap again to install')).toBeTruthy()
    expect(screen.getByText('This may briefly restart Home Assistant.')).toBeTruthy()
    expect(onService).not.toHaveBeenCalled()
  })

  it('proceeds with a disruptive update once confirmed', async () => {
    const onService = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('fetch', mockMaintenance(payload({
      updates: [update({ entityId: 'update.home_assistant_supervisor_update', name: 'Supervisor' })],
    })))
    render(<MaintenanceView onExpand={() => {}} onService={onService} />)

    await waitFor(() => expect(screen.getByText('Install')).toBeTruthy())
    fireEvent.click(screen.getByText('Install'))
    fireEvent.click(screen.getByText('Tap again to install'))

    await waitFor(() => expect(onService).toHaveBeenCalledWith('update', 'install', { entity_id: 'update.home_assistant_supervisor_update' }))
  })

  it('shows a failure notice rather than a silent no-op when the service call rejects', async () => {
    const onService = vi.fn().mockRejectedValue(new Error('boom'))
    vi.stubGlobal('fetch', mockMaintenance(payload({ updates: [update()] })))
    render(<MaintenanceView onExpand={() => {}} onService={onService} />)

    await waitFor(() => expect(screen.getByText('Install')).toBeTruthy())
    fireEvent.click(screen.getByText('Install'))

    await waitFor(() => expect(screen.getByText(/Could not start the Garage ESPHome update/)).toBeTruthy())
  })

  it('shows an in-progress install with its percentage instead of an Install button', async () => {
    vi.stubGlobal('fetch', mockMaintenance(payload({
      updates: [update({ inProgress: true, progressPercent: 42 })],
    })))
    render(<MaintenanceView onExpand={() => {}} onService={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Installing… 42%')).toBeTruthy())
    expect(screen.queryByText('Install')).toBeNull()
  })

  it('offers no install button for an update that cannot be installed from here', async () => {
    vi.stubGlobal('fetch', mockMaintenance(payload({ updates: [update({ canInstall: false })] })))
    render(<MaintenanceView onExpand={() => {}} onService={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Update manually')).toBeTruthy())
    expect(screen.queryByText('Install')).toBeNull()
  })

  it('a pending update keeps the header from reading "Nothing needs attention"', async () => {
    vi.stubGlobal('fetch', mockMaintenance(payload({ updates: [update()] })))
    render(<MaintenanceView onExpand={() => {}} onService={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Garage ESPHome')).toBeTruthy())
    expect(screen.getByText('1 thing needs attention')).toBeTruthy()
  })

  it('says nothing is due when there is nothing to fix and nothing to update', async () => {
    vi.stubGlobal('fetch', mockMaintenance(payload()))
    render(<MaintenanceView onExpand={() => {}} onService={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Nothing needs attention')).toBeTruthy())
    expect(screen.queryByText(/update available/)).toBeNull()
  })
})
