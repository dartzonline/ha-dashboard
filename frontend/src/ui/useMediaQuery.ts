import { useCallback, useSyncExternalStore } from 'react'

/**
 * Live `matchMedia` result. The shell needs to know when the nav rail is the always-visible
 * phone bar rather than the slide-in drawer, because only the drawer may be hidden from
 * assistive tech and made inert. Reports `false` where `matchMedia` does not exist (tests, SSR).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((notify: () => void) => {
    if (typeof window.matchMedia !== 'function') return () => {}
    const list = window.matchMedia(query)
    list.addEventListener('change', notify)
    return () => list.removeEventListener('change', notify)
  }, [query])
  const snapshot = () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  return useSyncExternalStore(subscribe, snapshot, () => false)
}
