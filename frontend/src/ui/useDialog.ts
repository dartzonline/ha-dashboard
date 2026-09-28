import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * Shared behaviour for every sheet, drawer and panel that sits over the page.
 *
 * - Escape closes it.
 * - Focus moves in on open (to `[data-autofocus]`, else the first button) and goes back to
 *   whatever had it when the sheet closes, so a keyboard or remote never gets stranded behind the
 *   scrim. Tab cycles inside the sheet.
 * - Everything behind it is made `inert` while it is open, so background tiles cannot be tabbed
 *   to or announced. That holds for a sheet rendered *inside* a background region too: only the
 *   parts of the region around it go inert.
 * - A wall panel must not sit on an open sheet forever because somebody brushed a tile walking
 *   past: after `idleMs` with no touch or key inside the sheet it closes itself. Any interaction
 *   restarts the countdown. Pass `idleMs: null` to opt out (e.g. a form mid-edit).
 */
export interface UseDialogOptions {
  onClose: () => void
  /** Auto-close after this long without interaction. Defaults to 2 minutes; `null` disables. */
  idleMs?: number | null
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Open dialog nodes, oldest first. Only the newest one is left interactive. */
const openDialogs: HTMLElement[] = []
/** Every element this module has made inert, with the `inert` it had before. The closed nav rail
 *  is inert in its own right; releasing a sheet must hand that back, not force it to false. */
const inertedByDialogs = new Map<HTMLElement, boolean>()

// Through the attribute rather than the `inert` property: browsers reflect one to the other, it
// is what React's own `inert` prop writes, and it also works where the property is missing.
function makeInert(element: HTMLElement) {
  if (!inertedByDialogs.has(element)) inertedByDialogs.set(element, element.hasAttribute('inert'))
  element.toggleAttribute('inert', true)
}

/**
 * Re-derives what is inert from scratch on every open and close. Each `[data-dialog-background]`
 * goes inert -- unless it *contains* the dialog (Insights opens its detail sheet inside <main>).
 * Then everything around the dialog inside it goes inert instead: every sibling along the path
 * from the dialog up to that container, which leaves the dialog itself live and nothing else.
 */
function refreshBackground() {
  inertedByDialogs.forEach((prior, element) => { element.toggleAttribute('inert', prior) })
  inertedByDialogs.clear()
  const dialog = openDialogs[openDialogs.length - 1]
  if (!dialog) return
  document.querySelectorAll<HTMLElement>('[data-dialog-background]').forEach((container) => {
    if (!container.contains(dialog)) {
      makeInert(container)
      return
    }
    let node: HTMLElement = dialog
    while (node !== container && node.parentElement) {
      const parent: HTMLElement = node.parentElement
      for (const sibling of Array.from(parent.children)) {
        if (sibling !== node && sibling instanceof HTMLElement) makeInert(sibling)
      }
      node = parent
    }
  })
}

export function useDialog<T extends HTMLElement = HTMLElement>({ onClose, idleMs = 120_000 }: UseDialogOptions): RefObject<T | null> {
  const ref = useRef<T | null>(null)
  // Kept in refs so the effect below never re-subscribes when the parent re-renders (which it
  // does on every Home Assistant state change).
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const previouslyFocused = document.activeElement as HTMLElement | null

    openDialogs.push(node)
    refreshBackground()

    const initial = node.querySelector<HTMLElement>('[data-autofocus]') ?? node.querySelector<HTMLElement>(FOCUSABLE) ?? node
    if (initial === node) node.tabIndex = -1
    // After the open animation starts, so the browser does not scroll the sheet mid-transition.
    const focusTimer = window.setTimeout(() => initial.focus({ preventScroll: true }), 30)

    let idleTimer: number | undefined
    function armIdle() {
      if (idleMs === null) return
      if (idleTimer) window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => onCloseRef.current(), idleMs)
    }
    armIdle()

    function handleKey(event: KeyboardEvent) {
      armIdle()
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !node) return
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.offsetParent !== null)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    function handlePointer() { armIdle() }

    document.addEventListener('keydown', handleKey, true)
    node.addEventListener('pointerdown', handlePointer)
    node.addEventListener('wheel', handlePointer, { passive: true })

    return () => {
      window.clearTimeout(focusTimer)
      if (idleTimer) window.clearTimeout(idleTimer)
      document.removeEventListener('keydown', handleKey, true)
      node.removeEventListener('pointerdown', handlePointer)
      node.removeEventListener('wheel', handlePointer)
      const index = openDialogs.lastIndexOf(node)
      if (index >= 0) openDialogs.splice(index, 1)
      refreshBackground()
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus({ preventScroll: true })
    }
  }, [idleMs])

  return ref
}
