import { useState, type CSSProperties } from 'react'
import { Flame, Gift, Snowflake, Star, TreePine } from 'lucide-react'
import './SeasonalEffects.css'

const holidayIcons = [Snowflake, Snowflake, Gift, Snowflake, Star, Snowflake, TreePine, Snowflake]
const apparitions = [
  'shining-axe', 'halloween-knife', 'pennywise', 'red-balloon',
  'scooby-doo', 'harry-potter-wand', 'beetlejuice',
] as const

const propImage = (name: typeof apparitions[number]) => `${import.meta.env.BASE_URL}seasonal/${name}.webp`
const ghostEdges = ['left', 'right', 'top', 'bottom'] as const

export function SeasonalEffects() {
  const [ghosts, setGhosts] = useState(() => Array.from({ length: 12 }, () => ({
    offset: Math.random() * 16, duration: 22 + Math.random() * 18, delay: -Math.random() * 40,
  })))
  const [visit, setVisit] = useState({ left: '50%', top: '52%', index: 0, lantern: true })
  const apparition = apparitions[visit.index]
  return <div className="seasonal-effects" aria-hidden="true">
    {(['holidays', 'halloween'] as const).map((season) => (
      <div className={`seasonal-layer seasonal-${season}`} key={season}>
        {season === 'halloween' && <>
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
            </div> : <img src={propImage(apparition)} alt="" draggable={false} decoding="async" />}
          </div>
        </>}
        {Array.from({ length: season === 'holidays' ? 20 : ghosts.length }, (_, index) => {
          const Symbol = holidayIcons[index % holidayIcons.length]
          const ornament = season === 'halloween' || Symbol !== Snowflake
          const left = ornament ? (index % 2 ? 96 - index % 5 : 2 + index % 5) : (index * 37) % 96 + 2
          const ghost = season === 'halloween' ? ghosts[index] : null
          const edge = ghost ? ghostEdges[index % ghostEdges.length] : undefined
          return <span className={`seasonal-particle${ornament ? ' seasonal-ornament' : ''}${edge ? ` ghost-edge-${edge}` : ''}`} data-edge={edge} key={index} onAnimationIteration={ghost ? () => {
            const offset = Math.random() * 16
            setGhosts((current) => current.map((item, ghostIndex) => ghostIndex === index ? { ...item, offset } : item))
          } : undefined} style={{
            '--particle-left': `${left}%`,
            '--particle-duration': `${ghost?.duration ?? 18 + index % 7 * 3}s`,
            '--particle-delay': `${ghost?.delay ?? -index * 3.7}s`,
            '--particle-sway': `${index % 2 ? -14 : 14}px`,
            '--ghost-offset': `${ghost?.offset ?? 0}px`,
          } as CSSProperties}>{season === 'halloween'
            ? <span className="border-ghost"><span className="border-ghost-face" /></span>
            : <Symbol size={ornament ? 26 : 9} strokeWidth={1.5} />}</span>
        })}
      </div>
    ))}
  </div>
}