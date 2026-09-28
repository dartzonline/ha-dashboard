/**
 * One chart vocabulary for every section view (constants half; the components live in
 * chartKit.tsx so fast refresh keeps working). Each view had grown its own tooltip style, grid
 * colour and hex series palette; these are the dataviz rules made concrete so a chart on
 * Insights reads exactly like one on Network:
 *
 * - series colours come from `--chart-1..6` in fixed order, and a seventh series is "Other";
 * - grid/axis/labels are recessive tokens, text never wears the series colour;
 * - 2px lines, thin bars with 4px rounded data-ends anchored to the baseline.
 */

export const SERIES_MAX = 6
/** Fold colour for the seventh-and-later series, always labelled "Other". */
export const OTHER_COLOR = 'var(--muted-2)'

/** Colour for the n-th series (0-based). Never cycles: past the sixth everything is "Other". */
export function seriesColor(index: number): string {
  return index >= 0 && index < SERIES_MAX ? `var(--chart-${index + 1})` : OTHER_COLOR
}

/** Tick text in rem so it scales with the wall-panel root size and stays legible from across the
 *  room (>= .7rem); the colour is the recessive chart ink, never the series colour. */
export const axisTick = { fontSize: '0.72rem', fill: 'var(--chart-ink)' } as const

/** Spread onto `<XAxis>`: a hairline baseline, no tick marks. */
export const xAxisProps = {
  tick: axisTick,
  tickLine: false,
  axisLine: { stroke: 'var(--chart-axis)' },
} as const

/** Spread onto `<YAxis>`: no axis line (the grid carries the scale), no tick marks. */
export const yAxisProps = {
  tick: axisTick,
  tickLine: false,
  axisLine: false,
  width: 48,
} as const

/** Spread onto `<CartesianGrid>`: solid hairlines, horizontal only. */
export const gridProps = { stroke: 'var(--chart-grid)', vertical: false } as const

export const chartMargin = { top: 8, right: 8, left: 0, bottom: 0 }

/** Line/area strokes. */
export const lineProps = { strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', dot: false, activeDot: { r: 4, strokeWidth: 2, stroke: 'var(--canvas)' } } as const

/** Vertical bars: 4px rounded data-end, square at the baseline, capped thickness. */
export const barProps = { radius: [4, 4, 0, 0] as [number, number, number, number], maxBarSize: 18 }
/** Horizontal bars grow from the left baseline, so the rounded end is on the right. */
export const hBarProps = { radius: [0, 4, 4, 0] as [number, number, number, number], maxBarSize: 14 }
/** The 2px surface gap between adjacent bars in a group. Pass to `<BarChart barGap>`. */
export const BAR_GAP = 2

/** Tooltip wrapper props: no cursor fill slab, a hairline cursor for line charts. */
export const tooltipCursor = { stroke: 'var(--chart-axis)', strokeWidth: 1 }
export const barTooltipCursor = { fill: 'rgba(255, 255, 255, .04)' }
