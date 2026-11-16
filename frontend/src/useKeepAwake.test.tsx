import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEEP_AWAKE_ATTRIBUTE, startKeepAwake, useKeepAwake } from './useKeepAwake'

function Probe() { useKeepAwake(); return null }

function fakeWakeLock() {
  const sentinels: { released: boolean; listeners: (() => void)[]; release: () => Promise<void>; addEventListener: (type: 'release', listener: () => void) => void }[] = []
  const request = vi.fn(async () => {
    const sentinel = {
      released: false,
      listeners: [] as (() => void)[],
      release: async () => { sentinel.released = true },
      addEventListener: (_type: 'release', listener: () => void) => { sentinel.listeners.push(listener) },
    }
    sentinels.push(sentinel)
    return sentinel
  })
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } })
  return { request, sentinels }
}

beforeEach(() => {
  document.documentElement.removeAttribute(KEEP_AWAKE_ATTRIBUTE)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'wakeLock')
  Reflect.deleteProperty(HTMLCanvasElement.prototype, 'captureStream')
  document.querySelectorAll('video').forEach((video) => video.remove())
})

describe('keeping the screen on', () => {
  it('takes a screen wake lock, takes it again after the browser lets go, and releases it on stop', async () => {
    const { request, sentinels } = fakeWakeLock()
    const stop = startKeepAwake()
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('screen'))
    await vi.waitFor(() => expect(sentinels[0]?.listeners.length).toBe(1))

    // The browser drops the lock whenever the page is hidden; coming back takes a new one.
    sentinels[0].listeners[0]()
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))

    stop()
    await vi.waitFor(() => expect(sentinels[1].released).toBe(true))
    expect(document.querySelector('video')).toBeNull()
  })

  it('falls back to a playing one-pixel video where there is no wake lock (a plain-http panel)', () => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: () => ({}) })
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ fillStyle: '', fillRect: vi.fn() })) as never
    const stop = startKeepAwake()
    const video = document.querySelector('video')
    expect(video).not.toBeNull()
    expect(video?.muted).toBe(true)
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
    stop()
    expect(document.querySelector('video')).toBeNull()
  })

  it('uses the video when the browser refuses the wake lock', async () => {
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: vi.fn(async () => { throw new Error('NotAllowedError') }) } })
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: () => ({}) })
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ fillStyle: '', fillRect: vi.fn() })) as never
    const stop = startKeepAwake()
    await vi.waitFor(() => expect(document.querySelector('video')).not.toBeNull())
    stop()
  })

  it('follows the setting: on by default, off when the page says so, on again after', async () => {
    const { request } = fakeWakeLock()
    render(<Probe />)
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))

    act(() => { document.documentElement.setAttribute(KEEP_AWAKE_ATTRIBUTE, 'off') })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    act(() => { document.documentElement.setAttribute(KEEP_AWAKE_ATTRIBUTE, 'on') })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  })

  it('does nothing at all while the setting is off', async () => {
    const { request } = fakeWakeLock()
    document.documentElement.setAttribute(KEEP_AWAKE_ATTRIBUTE, 'off')
    render(<Probe />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(request).not.toHaveBeenCalled()
  })
})
