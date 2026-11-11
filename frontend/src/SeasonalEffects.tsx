import { useEffect, useState, type CSSProperties } from 'react'
import { Cat, Flame, Ghost, Skull } from 'lucide-react'
import { FallScene } from './FallScene'
import { HolidayScene } from './HolidayScene'
import { WeatherScene } from './WeatherScene'
import { BurstLayer, useBursts, type Motion } from './seasonalPlay'
import type { SeasonalWeather } from './seasons'
import './SeasonalEffects.css'

const photoApparitions = [
  'shining-axe', 'halloween-knife', 'pennywise', 'red-balloon',
  'scooby-doo', 'harry-potter-wand', 'beetlejuice',
] as const
const drawnApparitions = ['ghost', 'skull', 'black-cat'] as const
const apparitions = [...photoApparitions, ...drawnApparitions] as const
const DRAWN_ICONS = { ghost: Ghost, skull: Skull, 'black-cat': Cat } as const
const HAUNTED_MOTION: Partial<Record<string, Motion>> = { 'jack-o-lantern': 'hop', skull: 'drop', 'black-cat': 'slide', 'red-balloon': 'swing' }

function usePageHidden() {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  useEffect(() => {
    const update = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return hidden
}

const isDrawnApparition = (name: typeof apparitions[number]): name is typeof drawnApparitions[number] =>
  (drawnApparitions as readonly string[]).includes(name)
const propImage = (name: typeof photoApparitions[number]) => `${import.meta.env.BASE_URL}seasonal/${name}.webp`
const ghostEdges = ['left', 'right', 'top', 'bottom'] as const

function DrawnApparition({ kind }: { kind: typeof drawnApparitions[number] }) {
  const Icon = DRAWN_ICONS[kind]
  return <Icon className="haunted-icon" strokeWidth={1.1} />
}

/**
 * `quiet` fades everything back while a dialog is open; `dimmed` thins it out at night; a hidden
 * tab pauses every animation so a sleeping tablet is not drawing snow nobody sees.
 */
export function SeasonalEffects({ weather, quiet = false, dimmed = false }: { weather: SeasonalWeather; quiet?: boolean; dimmed?: boolean }) {
  const hidden = usePageHidden()
  const { bursts, spawn } = useBursts()
  const [ghosts, setGhosts] = useState(() => Array.from({ length: 12 }, () => ({
    offset: Math.random() * 16, duration: 22 + Math.random() * 18, delay: -Math.random() * 40,
  })))
  const [visit, setVisit] = useState({ left: '50%', top: '52%', index: 0, lantern: true, popped: false })
  const apparition = apparitions[visit.index]
  const shown = visit.lantern ? 'jack-o-lantern' : apparition
  const effectsClass = ['seasonal-effects', quiet ? 'is-quiet' : '', dimmed ? 'is-dimmed' : '', hidden ? 'is-paused' : ''].filter(Boolean).join(' ')
  return <div className={effectsClass} aria-hidden="true">
    <div className="weather-layer"><WeatherScene weather={weather} /></div>
    <div className="seasonal-layer seasonal-holidays"><HolidayScene weather={weather} /></div>
    <div className="seasonal-layer seasonal-fall"><FallScene weather={weather} /></div>
    <div className="seasonal-layer seasonal-halloween">
      <div className="haunted-lanterns">
        <span className="haunted-lantern"><Flame size={24} /></span>
        <span className="haunted-lantern"><Flame size={24} /></span>
      </div>
      <div
        className={`haunted-visitor season-visitor${visit.popped ? ' is-popped' : ''}`}
        data-apparition={shown}
        data-motion={HAUNTED_MOTION[shown] ?? 'float'}
        data-swipe-ignore
        style={{ left: visit.left, top: visit.top }}
        onAnimationIteration={(event) => {
          if (event.target !== event.currentTarget) return
          setVisit({
            left: `${36 + Math.random() * 28}%`, top: `${36 + Math.random() * 28}%`,
            index: visit.lantern ? visit.index : (visit.index + 1 + Math.floor(Math.random() * (apparitions.length - 1))) % apparitions.length,
            lantern: !visit.lantern,
            popped: false,
          })
        }}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          spawn(box.left + box.width / 2, box.top + box.height / 2)
          setVisit((current) => ({ ...current, popped: true }))
        }}
      >
        {visit.lantern ? <div className="haunted-pumpkin">
          <span className="pumpkin-stem" />
          <span className="pumpkin-body"><span className="pumpkin-rib" /></span>
          <span className="pumpkin-eye pumpkin-eye-left" />
          <span className="pumpkin-eye pumpkin-eye-right" />
          <span className="pumpkin-nose" />
          <span className="pumpkin-grin" />
        </div> : isDrawnApparition(apparition)
          ? <DrawnApparition kind={apparition} />
          : <img src={propImage(apparition)} alt="" draggable={false} decoding="async" />}
      </div>
      <BurstLayer bursts={bursts} kind="spook" />
      {ghosts.map((ghost, index) => {
        const left = index % 2 ? 96 - index % 5 : 2 + index % 5
        const edge = ghostEdges[index % ghostEdges.length]
        return <span className={`seasonal-particle seasonal-ornament ghost-edge-${edge}`} data-edge={edge} key={index} onAnimationIteration={() => {
          const offset = Math.random() * 16
          setGhosts((current) => current.map((item, ghostIndex) => ghostIndex === index ? { ...item, offset } : item))
        }} style={{
          '--particle-left': `${left}%`,
          '--particle-duration': `${ghost.duration}s`,
          '--particle-delay': `${ghost.delay}s`,
          '--particle-sway': `${index % 2 ? -14 : 14}px`,
          '--ghost-offset': `${ghost.offset}px`,
        } as CSSProperties}><span className="border-ghost"><span className="border-ghost-face" /></span></span>
      })}
    </div>
  </div>
}