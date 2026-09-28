import { useState } from 'react'
import { apiUrl } from './api'
import { backdropPhotoFor } from './photoLibrary'
import type { BackdropStyle } from './photoLibrary'
import './PhotoBackdrop.css'

interface Layers {
  /** The photo fully on screen (or fading in over `previous`). */
  current: string | null
  /** The photo it replaced, kept underneath until the new one has finished fading in. */
  previous: string | null
}

/**
 * One photo behind a page, dimmed hard enough that the dashboard on top of it stays the thing being
 * read. Purely decorative: `aria-hidden`, and no pointer events, so it changes nothing about how
 * the page is used.
 *
 * Moving between two backdrop pages cross-fades: the old picture stays put until the new one has
 * actually *loaded*, then the new one fades in over it. Swapping a keyed `<img>` instead flashed
 * the bare canvas for however long the full-size file took to arrive over the LAN.
 */
export function PhotoBackdrop({ sectionId, photoIds, style = 'cinematic' }: {
  sectionId: string
  photoIds: string[]
  style?: BackdropStyle
}) {
  const [layers, setLayers] = useState<Layers>({ current: null, previous: null })
  const target = backdropPhotoFor(sectionId, photoIds)
  if (!target) return null

  const { current, previous } = layers
  const promote = (id: string) => setLayers((now) => (now.current === id ? now : { current: id, previous: now.current }))
  // Bottom to top: what is being replaced, what is showing, and the target on top (still loading,
  // or fading in). The target always goes last so it can never end up hidden under an older layer.
  const stack = [previous, current].filter((id): id is string => Boolean(id) && id !== target)
  stack.push(target)

  return (
    <div className={`photo-backdrop style-${style}`} aria-hidden="true">
      {stack.map((id) => (
        <img
          key={id}
          src={apiUrl(`photos/${id}/file`)}
          alt=""
          className={id === current ? 'is-current' : id === target ? 'is-loading' : 'is-previous'}
          decoding="async"
          onLoad={() => promote(id)}
          // Coming straight back to the page before last reuses an image that already loaded, so no
          // load event will come; promote it as soon as it is on top.
          ref={(node) => {
            if (node && id === target && id !== current && node.complete && node.naturalWidth > 0) queueMicrotask(() => promote(id))
          }}
          onAnimationEnd={() => setLayers((now) => (now.current === id && now.previous ? { current: id, previous: null } : now))}
        />
      ))}
      <span className="photo-backdrop-scrim" />
      {/* A darker band under the header and the page sub-heading, whatever the photo is doing there. */}
      <span className="photo-backdrop-band" />
    </div>
  )
}
