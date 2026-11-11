import { useCallback, useState, type AnimationEvent, type CSSProperties, type ReactNode } from 'react'

export type Motion = 'float' | 'slide' | 'hop' | 'swing' | 'drop'
export type BurstKind = 'snow' | 'leaf' | 'spook'

/** Deterministic 0..1 noise, so effects lay out the same on every render and in tests. */
export const rand = (index: number, salt: number) => {
  const x = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** What a tap does: picked at random each time, so popping a visitor stays a small surprise. */
export const burstVariants = ['burst', 'swirl', 'shower', 'ripple', 'critter'] as const
export type BurstVariant = typeof burstVariants[number]

interface Burst { id: number; x: number; y: number; variant: BurstVariant; dir: 1 | -1 }
let nextBurstId = 0
/** Long enough for the slowest reaction (a critter running off-screen). */
const BURST_LIFETIME_MS = 2800

export function useBursts(pick: () => number = Math.random) {
  const [bursts, setBursts] = useState<Burst[]>([])
  const spawn = useCallback((x: number, y: number) => {
    const id = nextBurstId++
    const variant = burstVariants[Math.min(burstVariants.length - 1, Math.floor(pick() * burstVariants.length))]
    const dir: 1 | -1 = x < window.innerWidth / 2 ? -1 : 1
    setBursts((current) => [...current.slice(-3), { id, x, y, variant, dir }])
    window.setTimeout(() => setBursts((current) => current.filter((burst) => burst.id !== id)), BURST_LIFETIME_MS)
  }, [pick])
  return { bursts, spawn }
}

const BURST_PARTICLES = 16
const SHOWER_PIECES = 12

/** The little character that runs, hops or flaps away from the tap. */
function Critter({ kind }: { kind: BurstKind }) {
  if (kind === 'spook') {
    return <svg viewBox="0 0 64 32" aria-hidden="true"><path className="critter-wing" d="M32 16 C24 4 10 4 2 12 C10 12 12 18 16 20 C20 16 26 18 32 22 Z M32 16 C40 4 54 4 62 12 C54 12 52 18 48 20 C44 16 38 18 32 22 Z" fill="#2b1f33" /><ellipse cx="32" cy="18" rx="5" ry="6" fill="#2b1f33" /><circle cx="30" cy="16" r="1" fill="#ffb36b" /><circle cx="34" cy="16" r="1" fill="#ffb36b" /></svg>
  }
  if (kind === 'snow') {
    return <svg viewBox="0 0 48 40" aria-hidden="true"><ellipse cx="22" cy="28" rx="14" ry="10" fill="#f4f8fb" /><circle cx="36" cy="18" r="8" fill="#f4f8fb" /><ellipse cx="34" cy="6" rx="2.6" ry="8" fill="#f4f8fb" transform="rotate(-12 34 6)" /><ellipse cx="40" cy="6" rx="2.6" ry="8" fill="#f4f8fb" transform="rotate(14 40 6)" /><circle cx="39" cy="17" r="1.3" fill="#1f1f27" /><circle cx="8" cy="26" r="4" fill="#fff" /></svg>
  }
  return <svg viewBox="0 0 56 40" aria-hidden="true"><path d="M10 30 C2 26 0 12 10 6 C16 2 22 8 18 14 C14 18 12 22 16 26 Z" fill="#a8622e" /><ellipse cx="30" cy="28" rx="13" ry="9" fill="#b9733a" /><circle cx="44" cy="20" r="7" fill="#b9733a" /><path d="M44 13 L46 8 L48 14 Z" fill="#a8622e" /><circle cx="47" cy="19" r="1.2" fill="#1a120c" /><path d="M24 36 L22 40 M36 36 L38 40" stroke="#7a4420" strokeWidth="2.4" strokeLinecap="round" /></svg>
}

export function BurstLayer({ bursts, kind }: { bursts: Burst[]; kind: BurstKind }) {
  return <>{bursts.map((burst) => {
    const style = { left: burst.x, top: burst.y, '--fall': `${Math.max(120, window.innerHeight - burst.y)}px`, '--dir': burst.dir } as CSSProperties
    if (burst.variant === 'ripple') {
      return <div className={`seasonal-burst burst-${kind} burst-ripple`} key={burst.id} style={style}>
        {[0, 1, 2].map((ring) => <i key={ring} style={{ animationDelay: `${ring * 0.18}s` }} />)}
        {Array.from({ length: 8 }, (_, index) => <span key={index} style={{ '--burst-angle': `${index * 45}deg`, '--burst-distance': '58px' } as CSSProperties} />)}
      </div>
    }
    if (burst.variant === 'critter') {
      return <div className={`seasonal-burst burst-${kind} burst-critter`} key={burst.id} style={style}>
        <div className="critter"><Critter kind={kind} /></div>
      </div>
    }
    if (burst.variant === 'shower') {
      return <div className={`seasonal-burst burst-${kind} burst-shower`} key={burst.id} style={style}>
        {Array.from({ length: SHOWER_PIECES }, (_, index) => <span key={index} style={{
          '--shower-x': `${(rand(index, burst.id) - 0.5) * 220}px`,
          '--shower-rise': `${40 + rand(index, burst.id + 3) * 70}px`,
          '--burst-spin': `${(rand(index, burst.id + 2) - 0.5) * 720}deg`,
          animationDelay: `${rand(index, burst.id + 5) * 0.15}s`,
        } as CSSProperties} />)}
      </div>
    }
    return <div className={`seasonal-burst burst-${kind} burst-${burst.variant}`} key={burst.id} style={style}>
      {Array.from({ length: BURST_PARTICLES }, (_, index) => <span key={index} style={{
        '--burst-angle': `${index * (360 / BURST_PARTICLES) + rand(index, burst.id) * 14}deg`,
        '--burst-distance': `${70 + rand(index, burst.id + 1) * 80}px`,
        '--burst-spin': `${(rand(index, burst.id + 2) - 0.5) * 540}deg`,
      } as CSSProperties} />)}
    </div>
  })}</>
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
