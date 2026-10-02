import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RadarPanel, type RadarOutlook } from './RadarPanel'

vi.mock('./cachedFetch', () => ({ cachedJson: vi.fn(() => Promise.resolve({ host: 'https://radar.example', frames: [{ time: 1000, path: '/frame/1' }, { time: 1600, path: '/frame/2' }] })), peekCached: () => undefined, isAbortError: () => false }))

const outlook: RadarOutlook = { peakRainChance: null, peakRainHour: null, nextWetDay: null, uvMax: null, windGusts: null, sunrise: null, sunset: null, airQuality: null }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) { this.callback = callback }
    observe() { this.callback([{ contentRect: { width: 512, height: 300 } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
    disconnect() {}
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('precipitation radar', () => {
  it('starts at the latest frame and keeps image nodes while playing buffered frames', async () => {
    const { container } = render(<RadarPanel latitude={40} longitude={-74} />)
    const timeline = screen.getByRole('slider', { name: 'Radar time' }) as HTMLInputElement
    await waitFor(() => expect(timeline.value).toBe('1'))
    vi.useFakeTimers()
    const images = [...container.querySelectorAll('.radar-precip img')]
    act(() => vi.advanceTimersByTime(3000))
    expect(timeline.value).toBe('1')
    images.forEach((image) => fireEvent.load(image))
    act(() => vi.advanceTimersByTime(1400))
    expect(timeline.value).toBe('0')
    expect(container.querySelector('.radar-precip img')).toBe(images[0])
    fireEvent.change(timeline, { target: { value: '1' } })
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy()
    expect(timeline.value).toBe('1')
  })

  it('reports tile failures and remounts imagery on retry', async () => {
    const { container } = render(<RadarPanel latitude={40} longitude={-74} />)
    await screen.findByText(/^As of/)
    const image = container.querySelector('.radar-precip img')!
    fireEvent.error(image)
    expect(screen.getByText('Map or radar tiles unavailable')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.queryByText('Map or radar tiles unavailable')).toBeNull()
    expect(container.querySelector('.radar-precip img')).not.toBe(image)
  })

  it('zooms without requesting unsupported radar zoom levels', async () => {
    const { container } = render(<RadarPanel latitude={40} longitude={-74} />)
    await screen.findByText(/^As of/)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in radar' }))
    expect((screen.getByRole('button', { name: 'Zoom in radar' }) as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelector('.radar-precip img')?.getAttribute('src')).toContain('/512/7/')
    for (let step = 0; step < 4; step++) fireEvent.click(screen.getByRole('button', { name: 'Zoom out radar' }))
    expect((screen.getByRole('button', { name: 'Zoom out radar' }) as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelector('.radar-precip img')?.getAttribute('src')).toContain('/512/6/')
  })

  it('does not infer clear radar from missing forecast probabilities', async () => {
    render(<RadarPanel latitude={40} longitude={-74} outlook={outlook} />)
    await screen.findByText(/^As of/)
    expect(screen.queryByText('Radar clear')).toBeNull()
    expect(screen.queryByText(/Low forecast rain chance/)).toBeNull()
  })

  it('keeps forecast probability separate from radar observations', async () => {
    render(<RadarPanel latitude={40} longitude={-74} outlook={{ ...outlook, peakRainChance: 10 }} />)
    await screen.findByText(/^As of/)
    expect(screen.getByRole('heading', { name: 'Precipitation radar' })).toBeTruthy()
    expect(screen.getByText(/Low forecast rain chance/)).toBeTruthy()
    expect(screen.queryByText(/No precipitation in range/)).toBeNull()
  })
})