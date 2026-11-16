import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShareSheet } from './ShareSheet'
import { SHARE_SHEET_SECONDS, homeAssistantLink, withHomeAssistant } from './shareLinks'

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

const WIFI = { configured: true, ssid: 'HomeNet', password: 'correct horse', security: 'WPA', hidden: false }
const LINKS = { links: [{ label: 'Plex', url: 'http://192.168.1.50:32400/web' }, { label: 'Hubitat', url: 'http://192.168.1.51' }] }

function stub(wifi: unknown = WIFI, links: unknown = LINKS) {
  const fetchMock = vi.fn(async (input: string) => new Response(JSON.stringify(String(input).includes('links') ? links : wifi)))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0) }) }

describe('ShareSheet', () => {
  it('shows every QR code at once, each with its name, fetched without caching', async () => {
    const fetchMock = stub()
    render(<ShareSheet onClose={vi.fn()} onOpenSettings={vi.fn()} />)
    await settle()
    expect(screen.getByRole('img', { name: 'QR code to join HomeNet' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'QR code to open Home Assistant' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'QR code to open Plex' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'QR code to open Hubitat' })).toBeTruthy()
    for (const title of ['Wi-Fi', 'Home Assistant', 'Plex', 'Hubitat']) expect(screen.getByText(title)).toBeTruthy()
    expect(screen.getByText('correct horse')).toBeTruthy()
    expect(screen.getByText('192.168.1.50:32400/web')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map((call) => (call as unknown as [string, RequestInit])[1].cache)).toEqual(['no-store', 'no-store'])
  })

  it('closes the whole sheet by itself after 30 seconds, not before', async () => {
    expect(SHARE_SHEET_SECONDS).toBe(30)
    stub()
    const onClose = vi.fn()
    render(<ShareSheet onClose={onClose} onOpenSettings={vi.fn()} />)
    await settle()
    await act(async () => { await vi.advanceTimersByTimeAsync((SHARE_SHEET_SECONDS - 1) * 1000) })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('Closes in 1s')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not restart its countdown when the page re-renders', async () => {
    stub()
    const onClose = vi.fn()
    const { rerender } = render(<ShareSheet onClose={() => onClose()} onOpenSettings={vi.fn()} />)
    await settle()
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    rerender(<ShareSheet onClose={() => onClose()} onOpenSettings={vi.fn()} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes when the area outside it is tapped, but not when the sheet itself is', async () => {
    stub()
    const onClose = vi.fn()
    const { container } = render(<ShareSheet onClose={onClose} onOpenSettings={vi.fn()} />)
    await settle()
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(container.querySelector('.detail-backdrop') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves the password out for an open network', async () => {
    stub({ configured: true, ssid: 'Cafe', password: '', security: 'nopass', hidden: false })
    render(<ShareSheet onClose={vi.fn()} onOpenSettings={vi.fn()} />)
    await settle()
    expect(screen.getByRole('img', { name: 'QR code to join Cafe' })).toBeTruthy()
    expect(document.querySelector('.share-password')).toBeNull()
  })

  it('still shows the links when no Wi-Fi is saved, and offers Settings', async () => {
    stub({ configured: false })
    const onOpenSettings = vi.fn()
    render(<ShareSheet onClose={vi.fn()} onOpenSettings={onOpenSettings} />)
    await settle()
    expect(screen.getByText('No Wi-Fi network has been added yet.')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'QR code to open Plex' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit in Settings' }))
    expect(onOpenSettings).toHaveBeenCalled()
  })

  it('works out Home Assistant from where the panel is served, unless the household saved its own', () => {
    const lan = { origin: 'http://192.168.1.20:8000', protocol: 'http:', hostname: '192.168.1.20', pathname: '/' }
    expect(homeAssistantLink(lan)).toEqual({ label: 'Home Assistant', url: 'http://192.168.1.20:8123' })
    const ingress = { origin: 'https://ha.example:8123', protocol: 'https:', hostname: 'ha.example', pathname: '/api/hassio_ingress/abc/' }
    expect(homeAssistantLink(ingress).url).toBe('https://ha.example:8123')
    const own = [{ label: 'home assistant', url: 'http://ha.local:8123' }]
    expect(withHomeAssistant(own, homeAssistantLink(lan))).toEqual(own)
    expect(withHomeAssistant([], homeAssistantLink(lan))).toHaveLength(1)
  })
})
