import { useEffect, useRef, useState } from 'react'

export interface SparkPoint {
  time: number
  value: number
}

interface SparklineProps {
  points: SparkPoint[]
  height?: number
}

/** Inline 24-hour trend: 2px line, ~10% area wash, end-dot with a surface ring. Decorative — the tile text carries the value. */
export function Sparkline({ points, height = 34 }: SparklineProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      setWidth(Math.round(entries[0]?.contentRect.width ?? 0))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const drawable = width > 24 && points.length > 1
  let linePath = ''
  let areaPath = ''
  let endX = 0
  let endY = 0

  if (drawable) {
    const padY = 5
    const dotSpace = 7
    const values = points.map((point) => point.value)
    const minValue = Math.min(...values)
    const maxValue = Math.max(...values)
    const spread = maxValue - minValue
    const firstTime = points[0].time
    const lastTime = points[points.length - 1].time
    const timeSpan = Math.max(1, lastTime - firstTime)
    const plotWidth = width - dotSpace
    const coords = points.map((point) => {
      const x = ((point.time - firstTime) / timeSpan) * plotWidth
      const y = spread === 0
        ? height / 2
        : padY + (1 - (point.value - minValue) / spread) * (height - padY * 2)
      return [x, y] as const
    })
    linePath = coords.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
    areaPath = `${linePath} L${coords[coords.length - 1][0].toFixed(1)},${height} L${coords[0][0].toFixed(1)},${height} Z`
    ;[endX, endY] = coords[coords.length - 1]
  }

  return (
    <div ref={containerRef} className="tile-spark" aria-hidden="true">
      {drawable && (
        <svg width={width} height={height}>
          <path d={areaPath} fill="var(--chart-line)" fillOpacity=".12" />
          <path d={linePath} fill="none" stroke="var(--chart-line)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx={endX} cy={endY} r="4" fill="var(--chart-line)" stroke="var(--surface)" strokeWidth="2" />
        </svg>
      )}
    </div>
  )
}
