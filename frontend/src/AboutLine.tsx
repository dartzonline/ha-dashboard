import { useEffect, useState } from 'react'
import { apiUrl } from './api'
import { formatReleased } from './aboutFormat'

interface About { version: string | null; releasedOn: string | null }

/** Top of Settings: which version is running, the day it was released, and the copyright. */
export function AboutLine() {
  const [about, setAbout] = useState<About | null>(null)

  useEffect(() => {
    const abort = new AbortController()
    fetch(apiUrl('about'), { signal: abort.signal, cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: About | null) => setAbout(data))
      // The version is a nicety: Settings works without it.
      .catch(() => undefined)
    return () => abort.abort()
  }, [])

  const released = about?.releasedOn ? formatReleased(about.releasedOn) : null
  return (
    <p className="config-about">
      <span>
        <strong>Home Panel</strong>
        {about?.version && <> v{about.version}</>}
        {released && <> · released {released}</>}
      </span>
      <span className="config-copyright">© 2026 Dart</span>
    </p>
  )
}
