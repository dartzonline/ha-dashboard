/** How long the whole Share sheet stays up. It is never extended: a Wi-Fi password should not linger on a wall panel. */
export const SHARE_SHEET_SECONDS = 30

export interface ShareLink { label: string; url: string }

/**
 * Home Assistant is always on the sheet, so nobody has to type its address: it is wherever this
 * page is served from, on its own port. Opened through Home Assistant's own sidebar, the page's
 * origin already is Home Assistant.
 */
export function homeAssistantLink(location: Pick<Location, 'origin' | 'protocol' | 'hostname' | 'pathname'> = window.location): ShareLink {
  const viaIngress = location.pathname.includes('/api/hassio_ingress/')
  return { label: 'Home Assistant', url: viaIngress ? location.origin : `${location.protocol}//${location.hostname}:8123` }
}

/** The saved links, with Home Assistant added unless the household has saved its own entry for it. */
export function withHomeAssistant(saved: ShareLink[], home: ShareLink = homeAssistantLink()): ShareLink[] {
  return saved.some((link) => link.label.trim().toLowerCase() === 'home assistant') ? saved : [home, ...saved]
}

/** A phone opens what it scans, so only plain web addresses are accepted. */
export function isWebAddress(value: string) {
  return /^https?:\/\/[^\s/]+[^\s]*$/i.test(value.trim())
}
