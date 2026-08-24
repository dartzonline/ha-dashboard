import { useEffect, useState } from 'react'
import { apiUrl } from './api'
import './PhotoBackdrop.css'

/**
 * Pages quiet enough to carry a picture behind them.
 *
 * These are the plain tile-grid pages: a handful of cards on an otherwise empty canvas, so there is
 * real space for a photo to be seen in. Everything else is deliberately left alone -- Insights,
 * Energy, Network, Health, Maintenance and Volvo are wall-to-wall charts and panels; World, Flights
 * and Weather are full-bleed maps and atmospheres that already fill the screen with their own
 * imagery; Home carries the moments strip and utility rail on top of its tiles; and Photos is the
 * library manager, where a backdrop would compete with the thumbnails it exists to show.
 *
 * Order matters: it is the assignment. The nth page in this list takes the nth photo in the
 * library, so each page keeps its own picture instead of every page showing the same one.
 */
export const BACKDROP_SECTIONS = ['climate', 'security', 'appliances', 'lights', 'scenes'] as const

export type BackdropStyle = 'dim' | 'cinematic' | 'duotone'

/** How long a photo stays on one page before the library is re-read and assignments can shift. */
const REFRESH_MS = 15 * 60_000

interface LibraryPhoto {
  id: string
}

/**
 * The photo library, fetched once for the whole app rather than per page.
 *
 * Pictures are added by hand and change on the order of days, so this refreshes on a long timer and
 * on nothing else -- a backdrop that reloaded on every page change would flicker on a wall panel
 * that rotates pages every twenty seconds.
 */
export function usePhotoLibrary(): string[] {
  const [ids, setIds] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    const abort = new AbortController()

    function load() {
      fetch(apiUrl('photos'), { signal: abort.signal })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error('unavailable'))))
        .then((data: LibraryPhoto[]) => {
          if (!cancelled) setIds(data.map((photo) => photo.id))
        })
        .catch(() => {
          // No library, or the backend is briefly unreachable: pages simply stay plain.
        })
    }

    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      abort.abort()
      window.clearInterval(timer)
    }
  }, [])

  return ids
}

/** The photo a given page should show, or null when the page takes no backdrop / library is empty. */
export function backdropPhotoFor(sectionId: string, photoIds: string[]): string | null {
  const slot = BACKDROP_SECTIONS.indexOf(sectionId as (typeof BACKDROP_SECTIONS)[number])
  if (slot < 0 || photoIds.length === 0) return null
  // Wraps, so a library smaller than the page list still gives every page something rather than
  // leaving the later pages blank.
  return photoIds[slot % photoIds.length]
}

/**
 * One photo behind a page, dimmed hard enough that the dashboard on top of it stays the thing being
 * read. Purely decorative: `aria-hidden`, and no pointer events, so it changes nothing about how
 * the page is used.
 */
export function PhotoBackdrop({ sectionId, photoIds, style = 'cinematic' }: {
  sectionId: string
  photoIds: string[]
  style?: BackdropStyle
}) {
  const photoId = backdropPhotoFor(sectionId, photoIds)
  if (!photoId) return null

  return (
    <div className={`photo-backdrop style-${style}`} aria-hidden="true">
      {/* Keyed by photo so a changed assignment re-runs the fade rather than swapping abruptly. */}
      <img key={photoId} src={apiUrl(`photos/${photoId}/file`)} alt="" />
      <span className="photo-backdrop-scrim" />
    </div>
  )
}
