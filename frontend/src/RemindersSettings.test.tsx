import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clockLabel, RemindersSettings, targetLabel } from './RemindersSettings'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const CONFIG = {
  binSchedule: { enabled: true, trashWeekday: 3, recycling: 'biweekly', recyclingAnchorDate: '2026-11-19', remindStart: '16:00', remindEnd: '22:00', intervalMinutes: 30 },
  notifications: { targets: [], forecast: true, houseWatch: true, bins: true, weekly: true, quietStart: '22:00', quietEnd: '07:00' },
}

function stub() {
  const calls: { url: string; method: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url.endsWith('notifications/targets')) return new Response(JSON.stringify({ targets: ['notify.mobile_app_pixel_8', 'notify.family'] }))
    if (url.endsWith('notifications/test')) return new Response(JSON.stringify({ status: 'sent' }))
    return new Response(JSON.stringify(CONFIG))
  }))
  return calls
}

describe('RemindersSettings', () => {
  it('shows the bin schedule and saves phones and quiet hours', async () => {
    const calls = stub()
    render(<RemindersSettings />)
    expect(await screen.findByDisplayValue('Thursday')).toBeTruthy()
    expect(screen.getByDisplayValue('Every other week')).toBeTruthy()
    expect(screen.getByDisplayValue('2026-11-19')).toBeTruthy()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Pixel 8' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Weekly report (Sunday 7 pm)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save reminders' }))
    expect(await screen.findByText('Reminders saved.')).toBeTruthy()
    const put = calls.find((call) => call.method === 'PUT')
    expect(put?.body).toMatchObject({
      binSchedule: { trashWeekday: 3, recycling: 'biweekly', remindStart: '16:00', intervalMinutes: 30 },
      notifications: { targets: ['notify.mobile_app_pixel_8'], weekly: false },
    })
  })

  it('sends a test to the chosen phones', async () => {
    const calls = stub()
    render(<RemindersSettings />)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Family' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send a test' }))
    await waitFor(() => expect(screen.getByText('Test sent. Check your phone.')).toBeTruthy())
    expect(calls.find((call) => call.url.endsWith('notifications/test'))?.body).toEqual({ targets: ['notify.family'] })
  })

  it('names phones readably', () => {
    expect(targetLabel('notify.mobile_app_pixel_8')).toBe('Pixel 8')
    expect(targetLabel('notify.family')).toBe('Family')
    expect(targetLabel('notify.mobile_app_anils_iphone')).toBe('Anils iPhone')
    expect(clockLabel('16:00')).toBe('4 pm')
    expect(clockLabel('21:30')).toBe('9:30 pm')
    expect(clockLabel('00:00')).toBe('12 am')
  })
})
