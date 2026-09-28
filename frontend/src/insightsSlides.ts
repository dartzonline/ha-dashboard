export interface InsightsSlideMeta {
  id: string
  /** Short tab label for the pager; the title is the longer eyebrow above the page heading. */
  label: string
  title: string
  subtitle: string
}

/** Insights is divided into fixed-height slides so nothing needs scrolling on a wall display. */
export const insightsSlides: InsightsSlideMeta[] = [
  { id: 'climate', label: 'Climate', title: 'Climate and comfort', subtitle: '24-hour room temperature with live telemetry' },
  { id: 'network', label: 'Network', title: 'Connectivity and energy', subtitle: 'Gateway throughput, monthly energy, softener salt' },
  { id: 'health', label: 'Health', title: 'Home health', subtitle: 'Batteries, plants, appliances, and maintenance' },
]

/** Each panel group holds for this long, so Insights stays on screen for slides x duration. */
export const rotationInterval = 20_000
