export interface DetailSeries {
  entityId: string
  label: string
  color: string
  /** Multiplier applied to raw recorder values, for example KiB/s to Mbps. */
  scale?: number
}

export interface DetailFactor {
  label: string
  value: string
  detail?: string
  tone?: 'good' | 'warn' | 'danger'
}

export interface DetailChip {
  label: string
  value: string
}

/** Everything an Insights tile needs to explain itself in an expanded panel. */
export interface InsightDetailConfig {
  id: string
  title: string
  subtitle: string
  value: string
  unit: string
  hours: number
  chart: 'line' | 'area'
  /** Comfort is computed from a temperature and humidity pair rather than charted directly. */
  derived?: 'comfort'
  series: DetailSeries[]
  explanation: string
  factors: DetailFactor[]
  chips?: DetailChip[]
}

export const detailColors = {
  temperature: '#ff8065',
  humidity: '#55a8ff',
  comfort: '#62d7d3',
  download: '#39df8b',
  upload: '#55a8ff',
  energy: '#ffc857',
  salt: '#32d5e2',
  plant: '#62d477',
  battery: '#ffc857',
  air: '#bb8cff',
  access: '#ff6469',
  neutral: '#7ba7d8',
}

/** Comfort score: 100 with penalties for drifting away from 72°F and 45% relative humidity. */
export function comfortScore(temperature: number, humidity: number) {
  const score = 100 - Math.abs(temperature - 72) * 4 - Math.abs(humidity - 45) * .8
  return Math.max(0, Math.min(100, Math.round(score)))
}

export function historyWindowLabel(hours: number) {
  if (hours <= 24) return 'Last 24 hours'
  if (hours <= 24 * 7) return 'Last 7 days'
  return 'Last 30 days'
}
