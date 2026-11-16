import { useEffect } from 'react'

/**
 * Keeps a wall tablet's screen from going to sleep while the dashboard is open.
 *
 * Two ways, in order:
 * 1. The Screen Wake Lock API. Browsers only offer it on secure pages (https or localhost), so on a
 *    panel served over plain http it is simply missing.
 * 2. A one-pixel video that is always playing. A browser keeps the display on while a video plays,
 *    which is how NoSleep-style libraries work. The video is a live stream drawn from a canvas, so
 *    there is no media file to ship.
 *
 * Neither can beat the device's own setting if that is stricter (a kiosk browser's screen-off timer,
 * the OS's sleep timer), so this is the app doing its part, not a guarantee.
 */
export const KEEP_AWAKE_ATTRIBUTE = 'data-theme-keep-awake'

type WakeLockSentinelLike = { release: () => Promise<void>; addEventListener: (type: 'release', listener: () => void) => void }
type WakeLockLike = { request: (type: 'screen') => Promise<WakeLockSentinelLike> }

/** Starts holding the screen on; the returned function lets go. */
export function startKeepAwake(): () => void {
  let active = true
  let sentinel: WakeLockSentinelLike | null = null
  let video: HTMLVideoElement | null = null
  let timer: number | undefined
  let drawn = 0

  function startVideo() {
    if (video || typeof document === 'undefined') return
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 2
    // Browsers that cannot stream a canvas cannot do this either way; ask before drawing anything.
    if (typeof canvas.captureStream !== 'function') return
    const context = canvas.getContext('2d')
    const stream = canvas.captureStream(1)
    if (!context || !stream) return
    // A stream with no new frames can end up treated as paused, so a frame is drawn every few seconds.
    const draw = () => { drawn += 1; context.fillStyle = drawn % 2 ? '#000000' : '#010101'; context.fillRect(0, 0, 2, 2) }
    draw()
    timer = window.setInterval(draw, 3_000)
    video = document.createElement('video')
    video.muted = true
    video.setAttribute('playsinline', '')
    video.setAttribute('aria-hidden', 'true')
    // Small, nearly clear and in the viewport: browsers hold the screen on only for a video they count as visible.
    Object.assign(video.style, { position: 'fixed', right: '0', bottom: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none', zIndex: '-1' })
    video.srcObject = stream
    document.body.appendChild(video)
    void play()
  }

  async function play() {
    try { await video?.play() } catch { /* Not allowed until the next touch; the pointerdown below retries. */ }
  }

  async function acquire() {
    if (!active || sentinel) return
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock
    if (!wakeLock) { startVideo(); return }
    try {
      const lock = await wakeLock.request('screen')
      if (!active) { void lock.release(); return }
      sentinel = lock
      // The browser lets go of it whenever the page is hidden; take it again when the page returns.
      lock.addEventListener('release', () => { sentinel = null })
    } catch {
      startVideo()
    }
  }

  function wake() {
    if (document.visibilityState === 'visible') {
      void acquire()
      if (video?.paused) void play()
    }
  }

  void acquire()
  document.addEventListener('visibilitychange', wake)
  document.addEventListener('pointerdown', wake)

  return () => {
    active = false
    document.removeEventListener('visibilitychange', wake)
    document.removeEventListener('pointerdown', wake)
    window.clearInterval(timer)
    void sentinel?.release()
    sentinel = null
    if (video) {
      video.pause()
      video.srcObject = null
      video.remove()
      video = null
    }
  }
}

/** Follows the "Keep the screen on" setting, which the theme paints onto the page as an attribute. */
export function useKeepAwake() {
  useEffect(() => {
    const root = document.documentElement
    let stop: (() => void) | null = null
    const sync = () => {
      const wanted = root.getAttribute(KEEP_AWAKE_ATTRIBUTE) !== 'off'
      if (wanted && !stop) stop = startKeepAwake()
      else if (!wanted && stop) { stop(); stop = null }
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: [KEEP_AWAKE_ATTRIBUTE] })
    return () => { observer.disconnect(); stop?.() }
  }, [])
}
