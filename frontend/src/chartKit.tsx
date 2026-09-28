import type { CSSProperties, ReactNode } from 'react'
import type { TooltipContentProps } from 'recharts'
import './chartKit.css'

/**
 * The HTML half of the chart kit (constants are in chartTheme.ts): the same small glass tooltip on
 * every chart, and a legend whenever a chart has two or more series.
 */

type ValueFormat = (value: number, name: string) => ReactNode
type LabelFormat = (label: string | number) => ReactNode

export type GlassTooltipProps = Partial<TooltipContentProps> & {
  valueFormat?: ValueFormat
  labelFormat?: LabelFormat
}

/**
 * The tooltip body, a small glass pane. Recharts colours each row in the series colour by default;
 * here the colour rides a swatch and the words stay in text ink.
 */
export function GlassTooltip({ active, payload, label, valueFormat, labelFormat }: GlassTooltipProps) {
  if (!active || !payload || payload.length === 0) return null
  const heading = label === undefined || label === '' ? null : labelFormat ? labelFormat(label) : label
  return (
    <div className="chart-tooltip glass-strong">
      {heading !== null && <p className="chart-tooltip-label">{heading}</p>}
      <ul>
        {payload.map((entry, index) => {
          const raw = entry.value
          const numeric = typeof raw === 'number' ? raw : Number(raw)
          const name = String(entry.name ?? entry.dataKey ?? '')
          const swatch = (entry.color ?? entry.stroke ?? entry.fill ?? (entry.payload as { fill?: string } | undefined)?.fill) as string | undefined
          return (
            <li key={`${name}-${index}`}>
              {swatch && <span className="chart-swatch" style={{ '--swatch': swatch } as CSSProperties} aria-hidden="true" />}
              {payload.length > 1 || name ? <span className="chart-tooltip-name">{name}</span> : null}
              <strong>{valueFormat && Number.isFinite(numeric) ? valueFormat(numeric, name) : String(raw ?? '')}</strong>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export interface LegendItem {
  label: ReactNode
  color: string
  /** `line` draws a short stroke key, `bar` a rounded square. */
  shape?: 'line' | 'bar'
  /** Optional current value shown after the label, as a selective direct label. */
  value?: ReactNode
}

/** HTML legend for charts with two or more series. Text is ink; identity is the key beside it. */
export function ChartLegend({ items, className = '' }: { items: LegendItem[]; className?: string }) {
  if (items.length < 2) return null
  return (
    <ul className={`chart-legend ${className}`.trim()}>
      {items.map((item, index) => (
        <li key={index}>
          <span className={`chart-key is-${item.shape ?? 'line'}`} style={{ '--swatch': item.color } as CSSProperties} aria-hidden="true" />
          <span>{item.label}</span>
          {item.value !== undefined && <strong>{item.value}</strong>}
        </li>
      ))}
    </ul>
  )
}
