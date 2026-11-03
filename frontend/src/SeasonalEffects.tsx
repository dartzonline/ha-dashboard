import { useState, type CSSProperties } from 'react'
import { Cat, Flame, Ghost, Skull } from 'lucide-react'
import { HolidayScene } from './HolidayScene'
import './SeasonalEffects.css'

const photoApparitions = [
  'shining-axe', 'halloween-knife', 'pennywise', 'red-balloon',
  'scooby-doo', 'harry-potter-wand', 'beetlejuice',
] as const
const drawnApparitions = ['ghost', 'skull', 'black-cat'] as const
const apparitions = [...photoApparitions, ...drawnApparitions] as const
const DRAWN_ICONS = { ghost: Ghost, skull: Skull, 'black-cat': Cat } as const

const isDrawnApparition = (name: typeof apparitions[number]): name is typeof drawnApparitions[number] =>
  (drawnApparitions as readonly string[]).includes(name)
const propImage = (name: typeof photoApparitions[number]) => `${import.meta.env.BASE_URL}seasonal/${name}.webp`
const ghostEdges = ['left', 'right', 'top', 'bottom'] as const

function DrawnApparition({ kind }: { kind: typeof drawnApparitions[number] }) {
  const Icon = DRAWN_ICONS[kind]
  return <Icon className="haunted-icon" strokeWidth={1.1} />
}

export function SeasonalEffects() {
  const [ghosts, setGhosts] = useState(() => Array.from({ length: 12 }, () => ({
    offset: Math.random() * 16, duration: 22 + Math.random() * 18, delay: -Math.random() * 40,
  })))
  const [visit, setVisit] = useState({ left: '50%', top: '52%', index: 0, lantern: true })
  const apparition = apparitions[visit.index]
  return <div className="seasonal-effects" aria-hidden="true">
    <div className="seasonal-layer seasonal-holidays"><HolidayScene /></div>
    <div className="seasonal-layer seasonal-halloween">
      <div className="haunted-lanterns">
        <span className="haunted-lantern"><Flame size={24} /></span>
        <span className="haunted-lantern"><Flame size={24} /></span>
      </div>
      <div className="haunted-visitor" data-apparition={visit.lantern ? 'jack-o-lantern' : apparition} style={{ left: visit.left, top: visit.top }} onAnimationIteration={() => setVisit({
        left: `${36 + Math.random() * 28}%`, top: `${36 + Math.random() * 28}%`,
        index: visit.lantern ? visit.index : (visit.index + 1 + Math.floor(Math.random() * (apparitions.length - 1))) % apparitions.length,
        lantern: !visit.lantern,
      })}>
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