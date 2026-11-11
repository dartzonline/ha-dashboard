import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WIFI_SHEET_SECONDS, WifiSheet } from './WifiSheet'

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

function stubWifi(body: unknown) {
  const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(body)))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const CONFIGURED = { configured: true, ssid: 'HomeNet', password: 'correct horse', security: 'WPA', hidden: false }

async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0) }) }

describe('WifiSheet', () => {
  it('shows the QR code, the network name and the password, fetched without caching', async () => {
    const fetchMock = stubWifi(CONFIGURED)
    render(<WifiSheet onClose={vi.fn()} onOpenSettings={vi.fn()} />)
    await settle()
    expect(screen.getByRole('img', { name: 'QR code to join HomeNet' })).toBeTruthy()
    expect(screen.getByText('HomeNet')).toBeTruthy()
    expect(screen.getByText('correct horse')).toBeTruthy()
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store' })
  })

  it('closes itself after 45 seconds, not before', async () => {
    stubWifi(CONFIGURED)
    const onClose = vi.fn()
    render(<WifiSheet onClose={onClose} onOpenSettings={vi.fn()} />)
    await settle()
    await act(async () => { await vi.advanceTimersByTimeAsync((WIFI_SHEET_SECONDS - 1) * 1000) })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('Closes in 1s')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not restart its countdown when the page re-renders', async () => {
    stubWifi(CONFIGURED)
    const onClose = vi.fn()
    const { rerender } = render(<WifiSheet onClose={() => onClose()} onOpenSettings={vi.fn()} />)
    await settle()
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    rerender(<WifiSheet onClose={() => onClose()} onOpenSettings={vi.fn()} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes when the area outside it is tapped, but not when the sheet itself is', async () => {
    stubWifi(CONFIGURED)
    const onClose = vi.fn()
    const { container } = render(<WifiSheet onClose={onClose} onOpenSettings={vi.fn()} />)
    await settle()
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(container.querySelector('.detail-backdrop') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves the password out for an open network', async () => {
    stubWifi({ configured: true, ssid: 'Cafe', password: '', security: 'nopass', hidden: false })
    render(<WifiSheet onClose={vi.fn()} onOpenSettings={vi.fn()} />)
    await settle()
    expect(screen.queryByText('Password')).toBeNull()
  })

  it('offers to set Wi-Fi up when none is saved', async () => {
    stubWifi({ configured: false })
    const onOpenSettings = vi.fn()
    render(<WifiSheet onClose={vi.fn()} onOpenSettings={onOpenSettings} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Add it in Settings' }))
    expect(onOpenSettings).toHaveBeenCalled()
  })
})
