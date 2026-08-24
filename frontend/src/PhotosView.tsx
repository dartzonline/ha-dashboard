import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronLeft, ChevronRight, Image as ImageIcon, Link2, Trash2, Upload,
} from 'lucide-react'
import { apiUrl } from './api'
import './PhotosView.css'

export interface Photo {
  id: string
  originalName: string | null
  contentType: string
  sizeBytes: number
  thumbBytes?: number
  originalBytes?: number
  width?: number
  height?: number
  addedAt: string
  sourceUrl: string | null
  position?: number
}

function megabytes(bytes: number | undefined) {
  if (bytes === undefined) return null
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}

/**
 * Manage the photo library: add pictures from this device or from a web address, see them as
 * thumbnails, reorder them, remove them.
 *
 * Deliberately a management screen rather than a display surface -- where these photos actually
 * appear on the wall panel is a separate decision, and keeping the two apart means that can change
 * without touching this.
 */
export function PhotosView() {
  const [photos, setPhotos] = useState<Photo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // Kept apart from `loadFailed` on purpose: every action ends by reloading the library, and a
  // successful reload would otherwise clear the very message explaining why the action failed.
  const [error, setError] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [url, setUrl] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)

  const load = useCallback((signal?: AbortSignal) => {
    fetch(apiUrl('photos'), { signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('unavailable'))))
      .then((data: Photo[]) => { setPhotos(data); setLoadFailed(false) })
      .catch((caught: unknown) => {
        if ((caught as { name?: string }).name === 'AbortError') return
        setLoadFailed(true)
      })
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    load(abort.signal)
    return () => abort.abort()
  }, [load])

  /** Shared by the file picker and drag-and-drop, which are the same operation from two entrances. */
  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files).filter((file) => file.type.startsWith('image/'))
    if (list.length === 0) {
      setError('Those files are not images.')
      return
    }

    setBusy(true)
    setError(null)
    setNotice(null)
    let added = 0
    for (const file of list) {
      const body = new FormData()
      body.append('file', file)
      try {
        const response = await fetch(apiUrl('photos'), { method: 'POST', body })
        if (!response.ok) {
          const detail = await response.json().catch(() => null)
          throw new Error(detail?.detail ?? 'Upload failed')
        }
        added += 1
      } catch (caught) {
        setError(caught instanceof Error ? `${file.name}: ${caught.message}` : `${file.name} could not be added.`)
      }
    }
    if (added > 0) setNotice(`Added ${added} photo${added === 1 ? '' : 's'}.`)
    setBusy(false)
    load()
  }

  async function addFromUrl() {
    const trimmed = url.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(apiUrl('photos/url'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => null)
        throw new Error(detail?.detail ?? 'Could not add that image')
      }
      setUrl('')
      setNotice('Added from the web.')
      load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add that image.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(photo: Photo) {
    const label = photo.originalName ?? 'this photo'
    if (!window.confirm(`Remove ${label}? This cannot be undone.`)) return
    setBusy(true)
    try {
      await fetch(apiUrl(`photos/${photo.id}`), { method: 'DELETE' })
      load()
    } catch {
      setError('Could not remove that photo.')
    } finally {
      setBusy(false)
    }
  }

  /** Moves one photo one place along, then persists the whole resulting order. */
  async function move(index: number, delta: number) {
    if (!photos) return
    const target = index + delta
    if (target < 0 || target >= photos.length) return

    const reordered = [...photos]
    const [moved] = reordered.splice(index, 1)
    reordered.splice(target, 0, moved)
    // Optimistic: the arrows are the one control here that gets tapped repeatedly, and waiting for
    // a round trip between each tap would make reordering feel broken.
    setPhotos(reordered)
    try {
      await fetch(apiUrl('photos/order'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: reordered.map((item) => item.id) }),
      })
    } catch {
      setError('Could not save the new order.')
      load()
    }
  }

  const total = photos?.reduce((sum, photo) => sum + photo.sizeBytes, 0) ?? 0

  return (
    <section
      className={`photos-view ${dragging ? 'is-dragging' : ''}`.trim()}
      aria-label="Photos"
      onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        void addFiles(event.dataTransfer.files)
      }}
    >
      <header>
        <div>
          <ImageIcon size={17} />
          <h2>Photos</h2>
        </div>
        <span>
          {photos === null ? 'Loading…' : `${photos.length} photo${photos.length === 1 ? '' : 's'}${total ? ` · ${megabytes(total)}` : ''}`}
        </span>
      </header>

      <div className="photos-add">
        <button type="button" className="photos-pick" onClick={() => fileInput.current?.click()} disabled={busy}>
          <Upload size={15} />
          {busy ? 'Working…' : 'Choose photos'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) void addFiles(event.target.files)
            // Cleared so picking the same file twice in a row still fires a change event.
            event.target.value = ''
          }}
        />
        <div className="photos-url">
          <Link2 size={15} />
          <input
            type="url"
            value={url}
            placeholder="…or paste an image address"
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void addFromUrl() }}
            disabled={busy}
          />
          <button type="button" onClick={() => void addFromUrl()} disabled={busy || !url.trim()}>Add</button>
        </div>
      </div>

      <p className="photos-hint">
        Drag pictures anywhere onto this page to add them. Each one is rotated upright, scaled to fit
        the panel and compressed on the way in, so the originals on your phone stay untouched.
      </p>

      {(error ?? (loadFailed ? 'Could not load the photo library.' : null)) && (
        <p className="photos-error" role="alert">{error ?? 'Could not load the photo library.'}</p>
      )}
      {notice && !error && <p className="photos-notice" role="status">{notice}</p>}

      {photos !== null && photos.length === 0 && (
        <div className="photos-empty">
          <ImageIcon size={30} />
          <p>No photos yet. Add a few and they will appear here.</p>
        </div>
      )}

      {photos !== null && photos.length > 0 && (
        <ul className="photos-grid">
          {photos.map((photo, index) => (
            <li key={photo.id}>
              <img src={apiUrl(`photos/${photo.id}/thumb`)} alt={photo.originalName ?? 'Photo'} loading="lazy" />
              <div className="photos-meta">
                <strong>{photo.originalName ?? 'Untitled'}</strong>
                <small>
                  {photo.width && photo.height ? `${photo.width}×${photo.height}` : ''}
                  {photo.originalBytes && photo.originalBytes > photo.sizeBytes
                    ? ` · ${megabytes(photo.sizeBytes)} (from ${megabytes(photo.originalBytes)})`
                    : ` · ${megabytes(photo.sizeBytes)}`}
                </small>
              </div>
              <div className="photos-actions">
                <button type="button" onClick={() => void move(index, -1)} disabled={index === 0} title="Move earlier" aria-label={`Move ${photo.originalName ?? 'photo'} earlier`}>
                  <ChevronLeft size={15} />
                </button>
                <button type="button" onClick={() => void move(index, 1)} disabled={index === photos.length - 1} title="Move later" aria-label={`Move ${photo.originalName ?? 'photo'} later`}>
                  <ChevronRight size={15} />
                </button>
                <button type="button" className="is-danger" onClick={() => void remove(photo)} title="Remove" aria-label={`Remove ${photo.originalName ?? 'photo'}`}>
                  <Trash2 size={15} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
