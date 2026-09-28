/**
 * The page on screen lives in the URL hash (`#/climate`, `#/insights/2`), so a reload -- which a
 * kiosk browser does on its own after a crash or a Wi-Fi drop -- comes back to the same page and
 * slide instead of starting over at Home. Slide numbers in the URL are 1-based, as in the
 * rotation label; slide 1 is left implicit.
 */
export interface ShellLocation {
  section: string | null
  /** 0-based slide index within the section; 0 when absent or unreadable. */
  slide: number
}

export function parseShellHash(hash: string): ShellLocation {
  const match = /^#\/([a-z0-9_-]+)(?:\/(\d+))?\/?$/i.exec(hash.trim())
  if (!match) return { section: null, slide: 0 }
  const slide = match[2] ? Math.max(0, Number(match[2]) - 1) : 0
  return { section: match[1].toLowerCase(), slide: Number.isFinite(slide) ? slide : 0 }
}

export function shellHash(section: string, slide = 0): string {
  return slide > 0 ? `#/${section}/${slide + 1}` : `#/${section}`
}

/** Clamps a slide index read from the URL to what the section actually has. */
export function clampSlide(slide: number, count: number): number {
  if (count <= 0) return 0
  return Math.min(Math.max(0, Math.floor(slide)), count - 1)
}

const ROTATION_HOLD_KEY = 'hc.rotationHeld'

/** Whether rotation was deliberately held with the rotation button, surviving a reload. */
export function readRotationHold(): boolean {
  try {
    return window.sessionStorage.getItem(ROTATION_HOLD_KEY) === '1'
  } catch {
    return false
  }
}

export function writeRotationHold(held: boolean) {
  try {
    if (held) window.sessionStorage.setItem(ROTATION_HOLD_KEY, '1')
    else window.sessionStorage.removeItem(ROTATION_HOLD_KEY)
  } catch {
    // Storage can be disabled in a locked-down kiosk; the hold then just lasts until reload.
  }
}
