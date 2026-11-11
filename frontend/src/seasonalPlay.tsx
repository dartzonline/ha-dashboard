import { useCallback, useState, type AnimationEvent, type CSSProperties, type ReactNode } from 'react'

export type Motion = 'float' | 'slide' | 'hop' | 'swing' | 'drop'
export type BurstKind = 'snow' | 'leaf' | 'spook'

/** Deterministic 0..1 noise, so effects lay out the same on every render and in tests. */
export const rand = (index: number, salt: number) => {
  const x = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453
  return x - Math.floor(x)
}

interface Burst { id: number; x: number; y: number }
let nextBurstId = 0

export function useBursts() {
  const [bursts, setBursts] = useState<Burst[]>([])
  const spawn = useCallback((x: number, y: number) => {
    const id = nextBurstId++
    setBursts((current) => [...current.slice(-3), { id, x, y }])
    window.setTimeout(() => setBursts((current) => current.filter((burst) => burst.id !== id)), 1400)
  }, [])
  return { bursts, spawn }
}

const BURST_PARTICLES = 16

export function BurstLayer({ bursts, kind }: { bursts: Burst[]; kind: BurstKind }) {
  return <>{bursts.map((burst) => (
    <div className={`seasonal-burst burst-${kind}`} key={burst.id} style={{ left: burst.x, top: burst.y }}>
      {Array.from({ length: BURST_PARTICLES }, (_, index) => <span key={index} style={{
        '--burst-angle': `${index * (360 / BURST_PARTICLES) + rand(index, burst.id) * 14}deg`,
        '--burst-distance': `${70 + rand(index, burst.id + 1) * 80}px`,
        '--burst-spin': `${(rand(index, burst.id + 2) - 0.5) * 540}deg`,
      } as CSSProperties} />)}
    </div>
  ))}</>
}

/** Where a visitor reappears next: somewhere near the middle, never hugging an edge. */
const nextSpot = () => ({ left: `${34 + Math.random() * 32}%`, top: `${36 + Math.random() * 28}%` })

/**
 * A character that fades in at a changing spot, one kind per visit. Tapping it pops it in a burst;
 * it comes back as the next kind on the following visit.
 */
export function RotatingVisitor<T extends string>({ kinds, className, motion, render, onPop }: {
  kinds: readonly T[]
  className: string
  motion: Record<T, Motion>
  render: (kind: T) => ReactNode
  onPop: (x: number, y: number) => void
}) {
  const [visit, setVisit] = useState({ left: '50%', top: '52%', index: 0, popped: false })
  const kind = kinds[visit.index]
  const advance = (event: AnimationEvent<HTMLDivElement>) => {
    // Twinkling ornaments inside the art fire their own iteration events; only the visit itself counts.
    if (event.target !== event.currentTarget) return
    setVisit((current) => ({ ...nextSpot(), index: (current.index + 1) % kinds.length, popped: false }))
  }
  return <div
    className={`${className} season-visitor${visit.popped ? ' is-popped' : ''}`}
    data-visitor={kind}
    data-motion={motion[kind]}
    data-swipe-ignore
    style={{ left: visit.left, top: visit.top }}
    onAnimationIteration={advance}
    onClick={(event) => {
      const box = event.currentTarget.getBoundingClientRect()
      onPop(box.left + box.width / 2, box.top + box.height / 2)
      setVisit((current) => ({ ...current, popped: true }))
    }}
  >{render(kind)}</div>
}
