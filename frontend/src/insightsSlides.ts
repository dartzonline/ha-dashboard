export interface InsightsSlideMeta {
  id: string
  title: string
  subtitle: string
}

/** Insights is divided into fixed-height slides so nothing needs scrolling on a wall display. */
export const insightsSlides: InsightsSlideMeta[] = [
  { id: 'climate', title: 'Climate and comfort', subtitle: '24-hour room temperature with live telemetry' },
  { id: 'network', title: 'Connectivity and energy', subtitle: 'Gateway throughput, monthly energy, softener salt' },
  { id: 'health', title: 'Home health', subtitle: 'Batteries, plants, appliances, and maintenance' },
]

/** Each panel group holds for this long, so Insights stays on screen for slides x duration. */
export const rotationInterval = 20_000
