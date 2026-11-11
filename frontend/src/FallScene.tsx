import { useMemo, type CSSProperties } from 'react'
import { FallVisitorArt, fallMotion, fallVisitors, Geese, Leaf, LEAF_COLORS, leafShapes } from './fallArt'
import { BurstLayer, rand, RotatingVisitor, useBursts } from './seasonalPlay'
import type { SeasonalWeather } from './seasons'
import './FallScene.css'

export { fallVisitors } from './fallArt'

// Fewer, quieter leaves read as autumn without competing with the dashboard's own content.
const LEAF_LAYERS = [
  { name: 'far', count: 8, size: [12, 18], duration: [22, 30] },
  { name: 'mid', count: 7, size: [20, 26], duration: [16, 22] },
  { name: 'near', count: 4, size: [28, 36], duration: [12, 16] },
] as const
/** Shown for Blizzard intensity, or when the forecast wind is strong enough to strip the trees. */
const EXTRA_LEAVES = 16
const GUST_LEAVES = 9
const PILE_LEAVES = 9
const WINDY_KMH = 25

const between = (range: readonly [number, number], t: number) => range[0] + (range[1] - range[0]) * t

function leafFall() {
  const leaves: { className: string; shape: typeof leafShapes[number]; color: string; style: CSSProperties }[] = []
  let index = 0
  const add = (layer: typeof LEAF_LAYERS[number], extra: boolean, dense: boolean) => {
    leaves.push({
      className: `leaf leaf-${layer.name}${extra ? ' is-extra' : dense ? ' is-dense' : ''}`,
      shape: leafShapes[index % leafShapes.length],
      color: LEAF_COLORS[Math.floor(rand(index, 1) * LEAF_COLORS.length)],
      style: {
        '--leaf-size': `${between(layer.size, rand(index, 2))}px`,
        '--leaf-left': `${rand(index, 3) * 100}%`,
        '--leaf-duration': `${between(layer.duration, rand(index, 4)) * (extra ? 0.8 : 1)}s`,
        '--leaf-delay': `${-rand(index, 5) * 30}s`,
        '--leaf-sway': `${30 + rand(index, 6) * 70}px`,
        '--leaf-spin': `${3 + rand(index, 7) * 5}s`,
        '--leaf-tilt': `${rand(index, 8)}`,
      } as CSSProperties,
    })
    index += 1
  }
  for (const layer of LEAF_LAYERS) for (let step = 0; step < layer.count; step += 1) add(layer, false, step % 2 === 1)
  for (let step = 0; step < EXTRA_LEAVES; step += 1) add(LEAF_LAYERS[step % LEAF_LAYERS.length], true, false)
  return leaves
}

export function FallScene({ weather }: { weather: SeasonalWeather }) {
  const leaves = useMemo(leafFall, [])
  const gust = useMemo(() => Array.from({ length: GUST_LEAVES }, (_, index) => ({
    shape: leafShapes[index % leafShapes.length],
    color: LEAF_COLORS[(index * 3) % LEAF_COLORS.length],
    top: 30 + rand(index, 20) * 50,
    delay: 9 + index * 0.22,
    lift: (rand(index, 21) - 0.5) * 30,
    size: 18 + rand(index, 22) * 18,
  })), [])
  const pile = useMemo(() => Array.from({ length: PILE_LEAVES }, (_, index) => ({
    shape: leafShapes[index % leafShapes.length],
    color: LEAF_COLORS[(index * 5) % LEAF_COLORS.length],
    left: rand(index, 30) * 98,
    bottom: rand(index, 31) * 18,
    rotate: rand(index, 32) * 360,
    size: 18 + rand(index, 33) * 16,
  })), [])
  const { bursts, spawn } = useBursts()
  // Leaves catch more wind than snow does.
  const windPx = Math.round(weather.windX * Math.min(weather.windKmh, 60) * 12)
  const sceneClass = [
    'fall-scene',
    weather.windKmh >= WINDY_KMH ? 'is-stormy' : '',
    weather.tempC !== null && weather.tempC <= 0 ? 'is-freezing' : '',
    weather.windX < 0 ? 'wind-left' : '',
  ].filter(Boolean).join(' ')

  return <div className={sceneClass} style={{ '--wind-x': `${windPx}px` } as CSSProperties}>
    <div className="fall-sky" />
    <div className="fall-moon" />
    <div className="season-frost" />
    <div className="fall-geese"><Geese /></div>
    {leaves.map((leaf, index) => <span className={leaf.className} key={index} style={leaf.style}>
      <span className="leaf-spin"><Leaf shape={leaf.shape} color={leaf.color} /></span>
    </span>)}
    <div className="fall-gust">
      {gust.map((leaf, index) => <span className="gust-leaf" key={index} style={{
        top: `${leaf.top}%`, width: leaf.size, animationDelay: `${leaf.delay}s`, '--gust-lift': `${leaf.lift}vh`,
      } as CSSProperties}><Leaf shape={leaf.shape} color={leaf.color} /></span>)}
    </div>
    <RotatingVisitor
      kinds={fallVisitors}
      className="fall-visitor"
      motion={fallMotion}
      render={(kind) => <FallVisitorArt kind={kind} />}
      onPop={spawn}
    />
    <BurstLayer bursts={bursts} kind="leaf" />
    <div className="fall-pile">
      {pile.map((leaf, index) => <span key={index} style={{
        left: `${leaf.left}%`, bottom: leaf.bottom, width: leaf.size, transform: `rotate(${leaf.rotate}deg)`,
      }}><Leaf shape={leaf.shape} color={leaf.color} /></span>)}
    </div>
  </div>
}
