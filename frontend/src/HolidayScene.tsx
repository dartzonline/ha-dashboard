import { useMemo, useState, type CSSProperties } from 'react'
import { Snowflake } from 'lucide-react'
import { holidayMotion, HolidayVisitorArt, holidayVisitors, Present, Sleigh } from './holidayArt'
import { BurstLayer, rand, RotatingVisitor, useBursts } from './seasonalPlay'
import type { SeasonalWeather } from './seasons'
import './HolidayScene.css'

export { holidayVisitors } from './holidayArt'

const BULBS_PER_SPAN = 4
const SPANS = 6
const BULB_COLORS = ['#ff5a5f', '#ffd166', '#5ddc8c', '#6ab7ff']
const PRESENT_COLORS: [string, string][] = [['#c8332f', '#ffd166'], ['#2f9a56', '#f4f1e7'], ['#2f5fb3', '#ffd166']]

/** Far flakes are small, slow and soft; near ones are big and quick. Together they read as depth. */
const SNOW_LAYERS = [
  { name: 'far', count: 26, size: [1.5, 3], duration: [18, 28], opacity: [0.3, 0.5] },
  { name: 'mid', count: 20, size: [3, 5], duration: [11, 18], opacity: [0.55, 0.75] },
  { name: 'near', count: 10, size: [6, 10], duration: [7, 11], opacity: [0.8, 0.95] },
] as const
/** Shown only for Blizzard intensity, or while the forecast says it is actually snowing. */
const EXTRA_FLAKES = 34
const BIG_FLAKES = 7

/** Where along its 80s loop the sleigh is above each scheduled gift, and how far across the sky. */
const SLEIGH_GIFTS = [{ at: 0.08, left: '16vw' }, { at: 0.16, left: '43vw' }, { at: 0.24, left: '69vw' }]
const SLEIGH_LOOP_S = 80
const SLEIGH_DELAY_S = 6

function stringLights() {
  const wire: string[] = []
  const bulbs: { x: number; y: number; color: string }[] = []
  const spanWidth = 100 / SPANS
  for (let span = 0; span < SPANS; span += 1) {
    const x0 = span * spanWidth
    const x1 = x0 + spanWidth
    const sag = 20 + rand(span, 3) * 6
    wire.push(`${span === 0 ? 'M' : 'L'}${x0},4 Q${(x0 + x1) / 2},${4 + sag} ${x1},4`)
    for (let step = 0; step < BULBS_PER_SPAN; step += 1) {
      const t = (step + 0.5) / BULBS_PER_SPAN
      const x = x0 + (x1 - x0) * t
      const y = (1 - t) ** 2 * 4 + 2 * (1 - t) * t * (4 + sag) + t ** 2 * 4
      bulbs.push({ x, y, color: BULB_COLORS[(span * BULBS_PER_SPAN + step) % BULB_COLORS.length] })
    }
  }
  return { path: wire.join(' '), bulbs }
}

const between = (range: readonly [number, number], t: number) => range[0] + (range[1] - range[0]) * t

function snowfall() {
  const flakes: { className: string; style: CSSProperties }[] = []
  let index = 0
  for (const layer of SNOW_LAYERS) {
    for (let step = 0; step < layer.count; step += 1, index += 1) {
      flakes.push({
        className: `snowflake flake-${layer.name}${step % 2 ? ' is-dense' : ''}`,
        style: {
          '--flake-size': `${between(layer.size, rand(index, 1))}px`,
          '--flake-left': `${rand(index, 2) * 100}%`,
          '--flake-duration': `${between(layer.duration, rand(index, 3))}s`,
          '--flake-delay': `${-rand(index, 4) * 28}s`,
          '--flake-sway': `${(rand(index, 5) - 0.5) * 90}px`,
          '--flake-opacity': between(layer.opacity, rand(index, 6)),
        } as CSSProperties,
      })
    }
  }
  for (let step = 0; step < EXTRA_FLAKES; step += 1, index += 1) {
    const layer = SNOW_LAYERS[step % SNOW_LAYERS.length]
    flakes.push({
      className: `snowflake flake-${layer.name} is-extra`,
      style: {
        '--flake-size': `${between(layer.size, rand(index, 1))}px`,
        '--flake-left': `${rand(index, 2) * 100}%`,
        '--flake-duration': `${between(layer.duration, rand(index, 3)) * 0.8}s`,
        '--flake-delay': `${-rand(index, 4) * 24}s`,
        '--flake-sway': `${(rand(index, 5) - 0.5) * 70}px`,
        '--flake-opacity': between(layer.opacity, rand(index, 6)),
      } as CSSProperties,
    })
  }
  return flakes
}

export function HolidayScene({ weather }: { weather: SeasonalWeather }) {
  const lights = useMemo(stringLights, [])
  const flakes = useMemo(snowfall, [])
  const bigFlakes = useMemo(() => Array.from({ length: BIG_FLAKES }, (_, index) => ({
    size: 22 + rand(index, 7) * 14,
    left: 4 + rand(index, 8) * 90,
    duration: 26 + rand(index, 9) * 18,
    delay: -rand(index, 10) * 40,
    sway: (rand(index, 11) - 0.5) * 120,
  })), [])
  const { bursts, spawn } = useBursts()
  const [droppedGifts, setDroppedGifts] = useState<{ id: number; x: number; y: number }[]>([])

  // A westerly at 30 km/h pushes snow about 240px to the right over one fall.
  const windPx = Math.round(weather.windX * Math.min(weather.windKmh, 60) * 8)
  const sceneClass = [
    'holiday-scene',
    weather.snowing ? 'is-stormy' : '',
    weather.tempC !== null && weather.tempC <= 0 ? 'is-freezing' : '',
  ].filter(Boolean).join(' ')

  return <div className={sceneClass} style={{ '--wind-x': `${windPx}px` } as CSSProperties}>
    <div className="holiday-sky" />
    <div className="holiday-aurora"><span /><span /><span /></div>
    <div className="holiday-star" />
    <div className="season-frost" />
    <div className="holiday-sleigh" data-swipe-ignore onClick={(event) => {
      const id = Date.now()
      setDroppedGifts((current) => [...current.slice(-4), { id, x: event.clientX, y: event.clientY }])
    }}><Sleigh /></div>
    {SLEIGH_GIFTS.map((gift, index) => <span className="sleigh-gift" key={index} style={{
      left: `calc(${gift.left} + 40px)`,
      animationDelay: `${SLEIGH_DELAY_S + gift.at * SLEIGH_LOOP_S}s`,
    }}><Present color={PRESENT_COLORS[index][0]} ribbon={PRESENT_COLORS[index][1]} /></span>)}
    {droppedGifts.map((gift, index) => <span className="dropped-gift" key={gift.id} style={{ left: gift.x, top: gift.y }}
      onAnimationEnd={() => setDroppedGifts((current) => current.filter((item) => item.id !== gift.id))}>
      <Present color={PRESENT_COLORS[index % PRESENT_COLORS.length][0]} ribbon={PRESENT_COLORS[index % PRESENT_COLORS.length][1]} />
    </span>)}
    {flakes.map((flake, index) => <span className={flake.className} key={index} style={flake.style} />)}
    {bigFlakes.map((flake, index) => <span className={`snowflake-big${index % 2 ? ' is-dense' : ''}`} key={index} style={{
      '--flake-left': `${flake.left}%`, '--flake-duration': `${flake.duration}s`,
      '--flake-delay': `${flake.delay}s`, '--flake-sway': `${flake.sway}px`,
    } as CSSProperties}><Snowflake size={flake.size} strokeWidth={1.3} /></span>)}
    <RotatingVisitor
      kinds={holidayVisitors}
      className="holiday-visitor"
      motion={holidayMotion}
      render={(kind) => <HolidayVisitorArt kind={kind} />}
      onPop={spawn}
    />
    <BurstLayer bursts={bursts} kind="snow" />
    <div className="holiday-drift" />
    <div className="holiday-lights">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none"><path d={lights.path} /></svg>
      {lights.bulbs.map((bulb, index) => <span className="holiday-bulb" key={index} style={{
        left: `${bulb.x}%`, top: `${bulb.y}px`, '--bulb-color': bulb.color, '--bulb-delay': `${-(index % 7) * 0.45}s`,
      } as CSSProperties} />)}
    </div>
  </div>
}
