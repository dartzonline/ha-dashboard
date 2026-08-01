function relativeApiPath(path: string) {
  return `api/${path.replace(/^\/?api\/?/, '').replace(/^\//, '')}`
}

export function apiUrl(path: string) {
  return new URL(relativeApiPath(path), document.baseURI).toString()
}

export function webSocketUrl(path: string) {
  const url = new URL(relativeApiPath(path), document.baseURI)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}
