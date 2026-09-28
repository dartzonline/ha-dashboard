import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HAEntity } from './types'
import { WeatherView } from './WeatherView'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function entities(list: HAEntity[]) {
  return new Map(list.map((entity) => [entity.entity_id, entity]))
}

const weather = { entity_id: 'weather.forecast_home', state: 'sunny', attributes: { temperature: 21 } } as unknown as HAEntity

describe('WeatherView pager', () => {
  it('is a tablist whose selected tab controls the panel', () => {
    render(<WeatherView entities={entities([weather])} slide={1} onSelectSlide={() => undefined} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(4)
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(tabs[1].getAttribute('tabindex')).toBe('0')
    expect(tabs[0].getAttribute('tabindex')).toBe('-1')
    const panel = screen.getByRole('tabpanel')
    expect(tabs[1].getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[1].id)
  })

  it('moves between panels with the arrow keys', () => {
    const onSelectSlide = vi.fn()
    render(<WeatherView entities={entities([weather])} slide={0} onSelectSlide={onSelectSlide} />)
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' })
    expect(onSelectSlide).toHaveBeenCalledWith(3)
  })

  it('says what it looks for when there is no weather source at all', () => {
    const light = { entity_id: 'light.kitchen', state: 'on', attributes: {} } as unknown as HAEntity
    render(<WeatherView entities={entities([light])} slide={0} onSelectSlide={() => undefined} />)
    expect(screen.getByText('No weather source found')).toBeTruthy()
  })
})
