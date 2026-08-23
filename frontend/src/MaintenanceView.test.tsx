import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MaintenanceView } from './MaintenanceView'

afterEach(() => {
  cleanup()
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
    const confirmSpy = vi.spyOn(window, 'confirm')
    render(<MaintenanceView onExpand={() => {}} onService={onService} />)

    await waitFor(() => expect(screen.getByText('Install')).toBeTruthy())
    fireEvent.click(screen.getByText('Install'))

    await waitFor(() => expect(onService).toHaveBeenCalledWith('update', 'install', { entity_id: 'update.esphome_garage_firmware' }))
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('asks for confirmation before installing a Home Assistant core/supervisor update', async () => {
    const onService = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('fetch', mockMaintenance(payload({
      updates: [update({ entityId: 'update.home_assistant_core_update', name: 'Home Assistant Core' })],
    })))
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<MaintenanceView onExpand={() => {}} onService={onService} />)

    await waitFor(() => expect(screen.getByText('Install')).toBeTruthy())
    fireEvent.click(screen.getByText('Install'))

    // Declined: the install must never have been sent.
    expect(window.confirm).toHaveBeenCalled()
    expect(onService).not.toHaveBeenCalled()
  })

  it('proceeds with a disruptive update once confirmed', async () => {
    const onService = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('fetch', mockMaintenance(payload({
      updates: [update({ entityId: 'update.home_assistant_supervisor_update', name: 'Supervisor' })],
    })))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<MaintenanceView onExpand={() => {}} onService={onService} />)

    await waitFor(() => expect(screen.getByText('Install')).toBeTruthy())
    fireEvent.click(screen.getByText('Install'))

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

  it('a pending update keeps the header from reading "Nothing due"', async () => {
    vi.stubGlobal('fetch', mockMaintenance(payload({ updates: [update()] })))
    render(<MaintenanceView onExpand={() => {}} onService={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Garage ESPHome')).toBeTruthy())
    expect(screen.getByText('Maintenance due')).toBeTruthy()
  })

  it('says nothing is due when there is nothing to fix and nothing to update', async () => {
    vi.stubGlobal('fetch', mockMaintenance(payload()))
    render(<MaintenanceView onExpand={() => {}} onService={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Nothing due')).toBeTruthy())
    expect(screen.queryByText(/update available/)).toBeNull()
  })
})
