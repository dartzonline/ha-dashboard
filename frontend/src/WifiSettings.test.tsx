import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectedNetworks, WifiSettings } from './WifiSettings'
import type { HAEntity } from './types'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const sensor = (id: string, state: string): [string, HAEntity] => [id, { entity_id: id, state, attributes: {}, last_changed: '', last_updated: '' }]
const entities = new Map([
  sensor('sensor.phone_ssid', 'HomeNet'), sensor('sensor.garage_node_ssid', 'HomeNet'),
  sensor('sensor.tv_ssid', 'unavailable'), sensor('sensor.living_room_temperature', '70'), sensor('sensor.iphone_ssid_2', 'GuestNet'),
])

function stub(saved: unknown) {
  const calls: { method: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
    if (init?.method === 'PUT') return new Response(JSON.stringify({ guestWifi: { ssid: 'HomeNet', security: 'WPA', hidden: false, hasPassword: true } }))
    return new Response(JSON.stringify({ guestWifi: saved }))
  }))
  return calls
}

describe('detectedNetworks', () => {
  it('lists each network devices report once and ignores dead sensors', () => {
    expect(detectedNetworks(entities)).toEqual(['HomeNet', 'GuestNet'])
  })
})

describe('WifiSettings', () => {
  it('offers detected networks and saves a new one with its password', async () => {
    const calls = stub(null)
    render(<WifiSettings entities={entities} />)
    fireEvent.click(await screen.findByRole('button', { name: 'HomeNet' }))
    const save = screen.getByRole('button', { name: /Save Wi-Fi/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Wi-Fi password'), { target: { value: 'short' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Wi-Fi password'), { target: { value: 'correct horse' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    expect(await screen.findByText(/Saved\./)).toBeTruthy()
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ guestWifi: { ssid: 'HomeNet', security: 'WPA', hidden: false, password: 'correct horse' } })
  })

  it('keeps the saved password when the box is left empty, and never receives it', async () => {
    const calls = stub({ ssid: 'HomeNet', security: 'WPA', hidden: false, hasPassword: true })
    render(<WifiSettings entities={new Map()} />)
    expect((await screen.findByLabelText('Wi-Fi network name') as HTMLInputElement).value).toBe('HomeNet')
    fireEvent.click(screen.getByLabelText('Hidden network'))
    fireEvent.click(screen.getByRole('button', { name: /Save Wi-Fi/ }))
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true))
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ guestWifi: { ssid: 'HomeNet', security: 'WPA', hidden: true } })
  })

  it('an open network needs no password', async () => {
    stub(null)
    render(<WifiSettings entities={new Map()} />)
    fireEvent.change(await screen.findByLabelText('Wi-Fi network name'), { target: { value: 'Cafe' } })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'nopass' } })
    expect(screen.queryByLabelText('Wi-Fi password')).toBeNull()
    expect((screen.getByRole('button', { name: /Save Wi-Fi/ }) as HTMLButtonElement).disabled).toBe(false)
  })
})
