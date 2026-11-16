import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinksSettings } from './LinksSettings'
import { isWebAddress } from './shareLinks'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function stub(links: unknown[] = []) {
  const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return new Response(JSON.stringify({ quickLinks: JSON.parse(String(init.body)).quickLinks }))
    return new Response(JSON.stringify({ links }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('LinksSettings', () => {
  it('accepts only web addresses', () => {
    expect(isWebAddress('http://192.168.1.5:8581')).toBe(true)
    expect(isWebAddress('https://plex.local/web')).toBe(true)
    for (const bad of ['192.168.1.5', 'http://', 'javascript:alert(1)', 'http://a b']) expect(isWebAddress(bad)).toBe(false)
  })

  it('adds a suggested name, takes the address and saves the links', async () => {
    const fetchMock = stub()
    render(<LinksSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Plex' }))
    const save = screen.getByRole('button', { name: /Save links/ })
    // "http://" alone is not an address yet.
    expect((save as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Link 1 address'), { target: { value: 'http://192.168.1.50:32400/web' } })
    expect((save as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(screen.getByText(/Saved/)).toBeTruthy())
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ quickLinks: [{ label: 'Plex', url: 'http://192.168.1.50:32400/web' }] })
  })

  it('removes a saved link', async () => {
    const fetchMock = stub([{ label: 'Hubitat', url: 'http://192.168.1.51' }])
    render(<LinksSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove link 1' }))
    fireEvent.click(screen.getByRole('button', { name: /Save links/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true))
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ quickLinks: [] })
  })
})
