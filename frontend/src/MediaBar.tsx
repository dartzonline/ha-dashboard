import { useState } from 'react'
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { apiUrl } from './api'
import type { HAEntity } from './types'
import './MediaBar.css'

function friendlyName(entity: HAEntity) {
  const name = entity.attributes.friendly_name
  return typeof name === 'string' && name.trim() ? name.trim() : entity.entity_id.split('.').slice(1).join('.')
}

function pickActiveEntity(entities: Map<string, HAEntity>) {
  const playing = [...entities.values()].filter(
    (entity) => entity.entity_id.startsWith('media_player.') && entity.state === 'playing',
  )
  if (playing.length === 0) return undefined
  return playing.sort((a, b) => Date.parse(b.last_changed) - Date.parse(a.last_changed))[0]
}

function artworkUrl(entity: HAEntity) {
  const picture = entity.attributes.entity_picture
  if (typeof picture !== 'string' || !picture) return undefined
  if (/^https?:\/\//i.test(picture)) return picture
  // Home Assistant's entity_picture path needs the backend's auth token, which the
  // browser never has — resolve it through the backend's entity-picture proxy instead
  // of fetching the raw HA-relative path directly.
  return apiUrl(`entity-picture/${entity.entity_id}`)
}

export function MediaBar({
  entities,
  onService,
}: {
  entities: Map<string, HAEntity>
  onService: (domain: string, service: string, data: Record<string, unknown>) => Promise<void>
}) {
  const [erroredSrc, setErroredSrc] = useState<string | undefined>(undefined)
  const active = pickActiveEntity(entities)
  if (!active) return null

  const title = typeof active.attributes.media_title === 'string' && active.attributes.media_title
    ? active.attributes.media_title
    : friendlyName(active)
  const subtitle = typeof active.attributes.media_artist === 'string' && active.attributes.media_artist
    ? active.attributes.media_artist
    : typeof active.attributes.app_name === 'string' && active.attributes.app_name
      ? active.attributes.app_name
      : friendlyName(active)
  const rawArtwork = artworkUrl(active)
  const artwork = rawArtwork && rawArtwork !== erroredSrc ? rawArtwork : undefined
  const isPlaying = active.state === 'playing'

  const call = (service: string) => {
    void onService('media_player', service, { entity_id: active.entity_id })
  }

  return (
    <div className="media-bar" role="region" aria-label="Now playing">
      <div className="media-bar-art" aria-hidden="true">
        {artwork
          ? <img src={artwork} alt="" onError={() => setErroredSrc(artwork)} />
          : <span className="media-bar-art-fallback" />}
      </div>
      <div className="media-bar-copy">
        <strong>{title}</strong>
        <small>{subtitle}</small>
      </div>
      <div className="media-bar-transport">
        <button type="button" className="icon-action" aria-label="Previous track" onClick={() => call('media_previous_track')}>
          <SkipBack size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-action"
          aria-label={isPlaying ? 'Pause' : 'Play'}
          onClick={() => call(isPlaying ? 'media_pause' : 'media_play')}
        >
          {isPlaying ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
        </button>
        <button type="button" className="icon-action" aria-label="Next track" onClick={() => call('media_next_track')}>
          <SkipForward size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
