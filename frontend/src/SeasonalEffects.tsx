import { useState, type CSSProperties } from 'react'
import { Flame, Gift, Ghost, Moon, Skull, Snowflake, Star, TreePine } from 'lucide-react'
import './SeasonalEffects.css'

const holidayIcons = [Snowflake, Snowflake, Gift, Snowflake, Star, Snowflake, TreePine, Snowflake]
const halloweenIcons = [Ghost, Moon, Skull, Ghost]

export function SeasonalEffects() {
  const [pumpkinPosition, setPumpkinPosition] = useState({ left: '50%', top: '52%' })
  return <div className="seasonal-effects" aria-hidden="true">
    {(['holidays', 'halloween'] as const).map((season) => (
      <div className={`seasonal-layer seasonal-${season}`} key={season}>
        {season === 'halloween' && <>
          <div className="haunted-lanterns">
            <span className="haunted-lantern"><Flame size={24} /></span>
            <span className="haunted-lantern"><Flame size={24} /></span>
          </div>
          <div className="haunted-pumpkin" style={pumpkinPosition} onAnimationIteration={() => setPumpkinPosition({
            left: `${36 + Math.random() * 28}%`, top: `${36 + Math.random() * 28}%`,
          })}>
            <span className="pumpkin-stem" />
            <span className="pumpkin-body"><span className="pumpkin-rib" /></span>
            <span className="pumpkin-eye pumpkin-eye-left" />
            <span className="pumpkin-eye pumpkin-eye-right" />
            <span className="pumpkin-nose" />
            <span className="pumpkin-grin" />
          </div>
        </>}
        {Array.from({ length: season === 'holidays' ? 20 : 8 }, (_, index) => {
          const symbols = season === 'holidays' ? holidayIcons : halloweenIcons
          const Symbol = symbols[index % symbols.length]
          const ornament = season === 'halloween' || Symbol !== Snowflake
          const left = ornament ? (index % 2 ? 96 - index % 5 : 2 + index % 5) : (index * 37) % 96 + 2
          return <span className={`seasonal-particle${ornament ? ' seasonal-ornament' : ''}`} key={index} style={{
            '--particle-left': `${left}%`,
            '--particle-duration': `${18 + index % 7 * 3}s`,
            '--particle-delay': `${-index * 3.7}s`,
            '--particle-sway': `${index % 2 ? -14 : 14}px`,
          } as CSSProperties}><Symbol size={ornament ? 26 : 9} strokeWidth={1.5} /></span>
        })}
      </div>
    ))}
  </div>
}