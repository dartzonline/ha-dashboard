import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCachedJson } from './cachedFetch'
import { AdGuardTab } from './AdGuardTab'
import { adguardModel, blockingState, compactCount, isLinked, sinceLabel } from './adguard'
import type { HAEntity } from './types'

beforeEach(() => {
  clearCachedJson()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([[]]))))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function entity(entityId: string, state: string, attributes: Record<string, unknown> = {}, lastChanged = '2026-11-14T10:00:00+00:00'): HAEntity {
  return { entity_id: entityId, state, attributes, last_changed: lastChanged, last_updated: lastChanged } as HAEntity
}

function linked(protection = 'on', filtering = 'on'): Map<string, HAEntity> {
  const items = [
    entity('switch.adguard_home_protection', protection),
    entity('switch.adguard_home_filtering', filtering),
    entity('switch.adguard_home_safe_browsing', 'on'),
    entity('switch.adguard_home_parental_control', 'off'),
    entity('sensor.adguard_home_dns_queries', '12345'),
    entity('sensor.adguard_home_dns_queries_blocked', '2469'),
    entity('sensor.adguard_home_dns_queries_blocked_ratio', '20.0'),
    entity('sensor.adguard_home_average_processing_speed', '4.2'),
    entity('sensor.adguard_home_rules_count', '98000'),
  ]
  return new Map(items.map((item) => [item.entity_id, item]))
}

describe('AdGuard entities', () => {
  it('finds switches and sensors by name, keeping the ratio apart from the blocked count', () => {
    const model = adguardModel(linked())
    expect(isLinked(model)).toBe(true)
    expect(model.switches.protection?.entity_id).toBe('switch.adguard_home_protection')
    expect(model.stats.queries?.state).toBe('12345')
    expect(model.stats.blocked?.state).toBe('2469')
    expect(model.stats.ratio?.state).toBe('20.0')
  })

  it('knows the add-on is installed even when it is not linked', () => {
    const model = adguardModel(new Map([['update.adguard_home_update', entity('update.adguard_home_update', 'off', { installed_version: '6.3.2' })]]))
    expect(isLinked(model)).toBe(false)
    expect(model.addon?.attributes.installed_version).toBe('6.3.2')
  })

  it('blocks only while protection AND filtering are on', () => {
    expect(blockingState(adguardModel(linked('on', 'on')))).toBe('working')
    expect(blockingState(adguardModel(linked('off', 'on')))).toBe('protection-off')
    expect(blockingState(adguardModel(linked('on', 'off')))).toBe('filtering-off')
    expect(blockingState(adguardModel(linked('unavailable', 'on')))).toBe('unknown')
  })

  it('formats counts and ages', () => {
    expect(compactCount(12345)).toBe('12.3k')
    expect(compactCount(999)).toBe('999')
    expect(compactCount(null)).toBe('—')
    const now = Date.parse('2026-11-15T12:00:00+00:00')
    expect(sinceLabel('2026-11-15T11:30:00+00:00', now)).toBe('30 min ago')
    expect(sinceLabel('2026-11-12T12:00:00+00:00', now)).toBe('3 days ago')
  })
})

describe('AdGuardTab', () => {
  it('explains how to connect it when only the add-on is installed', () => {
    const entities = new Map([['update.adguard_home_update', entity('update.adguard_home_update', 'off', { installed_version: '6.3.2' })]])
    render(<AdGuardTab entities={entities} onService={vi.fn()} />)
    expect(screen.getByText('Connect AdGuard Home to Home Assistant')).toBeTruthy()
    expect(screen.getByText(/add-on \(6\.3\.2\) is installed/)).toBeTruthy()
  })

  it('shows protection, the numbers and the filter switches', () => {
    render(<AdGuardTab entities={linked()} onService={vi.fn()} />)
    expect(screen.getByText('Blocking ads and trackers')).toBeTruthy()
    expect(screen.getByText('12.3k')).toBeTruthy()
    expect(screen.getByText('20.0')).toBeTruthy()
    expect(screen.getByRole('switch', { name: /Safe browsing/ }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: /Parental control/ }).getAttribute('aria-checked')).toBe('false')
  })

  it('charts lookups, blocked, block rate and answer speed, and shows what each filter has caught', () => {
    const entities = linked()
    for (const item of [
      entity('sensor.adguard_home_safe_browsing_blocked', '37'),
      entity('sensor.adguard_home_parental_control_blocked', '0'),
    ]) entities.set(item.entity_id, item)
    render(<AdGuardTab entities={entities} onService={vi.fn()} />)
    for (const title of ['Lookups over time', 'Blocked over time', 'Block rate', 'Answer speed']) {
      expect(screen.getByRole('region', { name: title })).toBeTruthy()
    }
    expect(screen.getByText('37 blocked')).toBeTruthy()
  })

  it('says plainly when nothing is being blocked', () => {
    render(<AdGuardTab entities={linked('off')} onService={vi.fn()} />)
    expect(screen.getByText('Protection is off')).toBeTruthy()
    expect(screen.getByText(/Nothing is being blocked/)).toBeTruthy()
  })

  it('needs a second tap to switch protection off, but not to switch it on', async () => {
    const onService = vi.fn(async () => [])
    const { unmount } = render(<AdGuardTab entities={linked('on')} onService={onService} />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }))
    expect(onService).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to switch off' }))
    await waitFor(() => expect(onService).toHaveBeenCalledWith('switch', 'turn_off', { entity_id: 'switch.adguard_home_protection' }))
    unmount()

    const again = vi.fn(async () => [])
    render(<AdGuardTab entities={linked('off')} onService={again} />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch on' }))
    await waitFor(() => expect(again).toHaveBeenCalledWith('switch', 'turn_on', { entity_id: 'switch.adguard_home_protection' }))
  })

  it('switches the lesser filters in one tap and reports a failure', async () => {
    const onService = vi.fn(async () => { throw new Error('Home Assistant is offline') })
    render(<AdGuardTab entities={linked()} onService={onService} />)
    fireEvent.click(screen.getByRole('switch', { name: /Safe browsing/ }))
    await waitFor(() => expect(onService).toHaveBeenCalledWith('switch', 'turn_off', { entity_id: 'switch.adguard_home_safe_browsing' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Home Assistant is offline')).toBeTruthy()
  })
})
