/**
 * Shapes and formatters for `/api/insights/network`, shared by the Network page and the WAN
 * sensor's detail sheet. Kept apart from the components so the component files export only
 * components (which is what keeps fast refresh working).
 */
import { seriesColor } from './chartTheme'

/** Fixed series order, shared by the charts, their legend and the summary cards' keys. */
export const DOWNLOAD_COLOR = seriesColor(0)
export const UPLOAD_COLOR = seriesColor(1)
export const DEVICES_COLOR = seriesColor(2)

export interface NetworkPoint {
  time: string
  downloadMbps: number | null
  uploadMbps: number | null
  devices: number
}

export interface Summary {
  average: number | null
  min: number | null
  max: number | null
}

export interface OutageEvent {
  start: string
  end: string
  seconds: number
  ongoing: boolean
  blip: boolean
  sources: string[]
}

export interface Connectivity {
  uptimePercent: number
  downSeconds: number
  outageCount: number
  blipCount: number
  longestSeconds: number
  ongoing: boolean
  resolutionSeconds: number | null
  observedHours: number
  events: OutageEvent[]
  ipChanges: { at: string; from: string; to: string }[]
  wanState: string | null
  externalIp: string | null
}

export interface NetworkPayload {
  hours: number
  points: NetworkPoint[]
  download: Summary
  upload: Summary
  devices: Summary & { now: number; tracked: number }
  connectivity?: Connectivity
}

export interface ChartRow {
  hour: number
  download: number | null
  upload: number | null
  devices: number
}

/** Hourly averages barely move inside five minutes, and the page re-mounts every rotation. */
export const NETWORK_CACHE_TTL_MS = 5 * 60_000

export function networkPath(hours: number) {
  return `insights/network?hours=${hours}`
}

export function clientsPath(hours: number) {
  return `insights/clients?hours=${hours}`
}

export function toChartRows(payload: NetworkPayload | null): ChartRow[] {
  return (payload?.points ?? []).map((point) => ({
    hour: Date.parse(point.time),
    download: point.downloadMbps,
    upload: point.uploadMbps,
    devices: point.devices,
  }))
}

export function formatHour(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric' })
}

export function mbps(value: number | null | undefined) {
  return value === null || value === undefined ? '--' : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} Mbps`
}

/** Compact duration: outages run from sub-second blips to hours. */
export function duration(seconds: number) {
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
}
