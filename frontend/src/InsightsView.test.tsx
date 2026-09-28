import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InsightsView } from './InsightsView'
import type { HAEntity } from './types'

vi.mock('./history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./history')>()),
  fetchHistory: vi.fn(() => Promise.resolve([[]])),
}))

class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }

beforeEach(() => { vi.stubGlobal('ResizeObserver', NoopResizeObserver) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function entity(entity_id: string, state: string, attributes: Record<string, unknown> = {}): HAEntity {
  return { entity_id, state, attributes, last_changed: '', last_updated: '' } as unknown as HAEntity
}

function entities(...list: HAEntity[]) {
  return new Map(list.map((item) => [item.entity_id, item]))
}

const home = entities(
  entity('sensor.main_floor_temperature', '71.5'),
  entity('sensor.cbr750_gateway_download_speed', '1200'),
  entity('binary_sensor.cbr750_gateway_wan_status', 'on'),
  entity('sensor.front_door_battery', '12', { device_class: 'battery', friendly_name: 'Front door battery' }),
  entity('sensor.kitchen_motion_battery', '35', { device_class: 'battery', friendly_name: 'Kitchen motion battery' }),
  entity('sensor.lawn_plant_sensor_maple_humidity', '15', { device_class: 'humidity', friendly_name: 'Maple plant sensor humidity' }),
)

describe('InsightsView', () => {
  it('renders the slide pager as a labelled tablist with arrow-key navigation', () => {
    const onSelectSlide = vi.fn()
    render(<InsightsView entities={home} series={new Map()} loading={false} slide={0} onSelectSlide={onSelectSlide} />)
    const tablist = screen.getByRole('tablist', { name: 'Insights panels' })
    const tabs = within(tablist).getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Climate', 'Network', 'Health'])
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(tabs[0].getAttribute('tabindex')).toBe('0')
    expect(tabs[1].getAttribute('tabindex')).toBe('-1')
    const panel = screen.getByRole('tabpanel')
    expect(tabs[0].getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0].id)

    fireEvent.keyDown(tablist, { key: 'ArrowRight' })
    expect(onSelectSlide).toHaveBeenCalledWith(1)
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' })
    expect(onSelectSlide).toHaveBeenCalledWith(2)
  })

  it('carries low batteries and dry plants as words, not only colour', () => {
    render(<InsightsView entities={home} series={new Map()} loading={false} slide={2} onSelectSlide={() => {}} />)
    expect(screen.getByRole('heading', { name: '1 battery needs replacing' })).toBeTruthy()
    expect(screen.getByRole('meter', { name: /Maple.*soil moisture/ }).getAttribute('aria-valuenow')).toBe('15')
    expect(screen.getByText('Dry')).toBeTruthy()
  })

  it('opens the explanation sheet as a modal dialog', () => {
    render(<InsightsView entities={home} series={new Map()} loading={false} slide={0} onSelectSlide={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Explain Comfort score' }))
    const dialog = screen.getByRole('dialog', { name: 'Comfort score' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('explains what it looks for when no insight sensors exist', () => {
    render(<InsightsView entities={entities(entity('light.kitchen', 'on'))} series={new Map()} loading={false} slide={0} onSelectSlide={() => {}} />)
    expect(screen.getByText('Nothing to chart yet')).toBeTruthy()
    expect(screen.getByText(/Looks for room temperature sensors/)).toBeTruthy()
  })
})
