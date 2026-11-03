import { useMemo, useState, type CSSProperties } from 'react'
import { Bell, CandyCane, Gift, Snowflake } from 'lucide-react'
import './HolidayScene.css'

const rand = (index: number, salt: number) => {
  const x = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453
  return x - Math.floor(x)
}

const FLAKES = 54
const BIG_FLAKES = 7
const BULBS_PER_SPAN = 4
const SPANS = 6
const BULB_COLORS = ['#ff5a5f', '#ffd166', '#5ddc8c', '#6ab7ff']

export const holidayVisitors = ['snowman', 'tree', 'gingerbread', 'wreath', 'gift', 'candy-cane', 'bell'] as const
export type HolidayVisitor = typeof holidayVisitors[number]

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

function Reindeer({ x, lead }: { x: number; lead?: boolean }) {
  return <g transform={`translate(${x} 0)`}>
    <line x1="-14" y1="66" x2="-26" y2="82" stroke="#6b4226" strokeWidth="4" strokeLinecap="round" />
    <line x1="-6" y1="68" x2="-12" y2="86" stroke="#6b4226" strokeWidth="4" strokeLinecap="round" />
    <line x1="10" y1="68" x2="22" y2="80" stroke="#6b4226" strokeWidth="4" strokeLinecap="round" />
    <line x1="16" y1="66" x2="30" y2="74" stroke="#6b4226" strokeWidth="4" strokeLinecap="round" />
    <ellipse cx="2" cy="60" rx="20" ry="9" fill="#8b5a36" />
    <path d="M16 56 L28 40 L36 44 L24 62 Z" fill="#8b5a36" />
    <ellipse cx="34" cy="40" rx="9" ry="6" transform="rotate(-20 34 40)" fill="#9a6640" />
    <circle cx="43" cy="39" r={lead ? 3.4 : 2} fill={lead ? '#ff3b3b' : '#2a1a10'} className={lead ? 'rudolph-nose' : undefined} />
    <circle cx="33" cy="37" r="1.3" fill="#1c120b" />
    <path d="M30 34 L26 22 M26 22 L20 18 M26 22 L28 14 M34 33 L34 20 M34 20 L41 15 M34 20 L33 12" stroke="#d9b98a" strokeWidth="2" strokeLinecap="round" fill="none" />
  </g>
}

function Sleigh() {
  return <svg className="holiday-sleigh-art" viewBox="0 0 290 100" aria-hidden="true">
    <path d="M52 62 Q150 56 196 60" stroke="#e8d291" strokeWidth="1.2" fill="none" />
    <Reindeer x={226} lead />
    <Reindeer x={168} />
    <path d="M6 88 H78 Q96 88 94 70" stroke="#e8c15a" strokeWidth="4" fill="none" strokeLinecap="round" />
    <path d="M18 88 V74 M60 88 V74" stroke="#e8c15a" strokeWidth="3" />
    <path d="M10 56 H88 C88 76 78 82 62 82 H34 C18 82 10 74 10 56 Z" fill="#c8332f" />
    <path d="M10 56 H88" stroke="#f0c75e" strokeWidth="3" />
    <circle cx="30" cy="48" r="13" fill="#a82723" />
    <path d="M24 44 L30 36 L36 44" stroke="#f0c75e" strokeWidth="2.4" fill="none" />
    <circle cx="62" cy="38" r="9" fill="#f2c9a5" />
    <path d="M52 36 Q62 22 72 36 Z" fill="#d32f2f" />
    <circle cx="62" cy="21" r="3.4" fill="#fff" />
    <rect x="52" y="34" width="20" height="4" rx="2" fill="#fff" />
    <path d="M54 42 Q62 56 70 42 Z" fill="#fff" />
    <rect x="52" y="48" width="22" height="12" rx="4" fill="#d32f2f" />
  </svg>
}

function Snowman() {
  return <svg viewBox="0 0 100 120" className="holiday-art" aria-hidden="true">
    <defs><radialGradient id="snow-shade" cx="38%" cy="32%" r="75%"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#b9cde0" /></radialGradient></defs>
    <path d="M20 54 L4 40 M16 48 L6 50 M80 54 L96 38 M84 48 L94 50" stroke="#6b4226" strokeWidth="3" strokeLinecap="round" />
    <circle cx="50" cy="88" r="28" fill="url(#snow-shade)" />
    <circle cx="50" cy="55" r="21" fill="url(#snow-shade)" />
    <circle cx="50" cy="26" r="15" fill="url(#snow-shade)" />
    <rect x="35" y="9" width="30" height="5" rx="2" fill="#1f1f27" />
    <rect x="40" y="-4" width="20" height="14" rx="2" fill="#2a2a34" />
    <rect x="40" y="4" width="20" height="3.5" fill="#c8332f" />
    <circle cx="44" cy="23" r="2" fill="#1f1f27" />
    <circle cx="56" cy="23" r="2" fill="#1f1f27" />
    <path d="M50 27 L68 31 L50 33 Z" fill="#ef8a2a" />
    <path d="M42 33 Q50 38 58 33" stroke="#1f1f27" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    <path d="M32 40 Q50 48 68 40 L67 47 Q50 55 33 47 Z" fill="#c8332f" />
    <path d="M60 46 L66 64 L58 62 Z" fill="#a82723" />
    <circle cx="50" cy="62" r="2.4" fill="#1f1f27" />
    <circle cx="50" cy="73" r="2.4" fill="#1f1f27" />
    <circle cx="50" cy="90" r="2.8" fill="#1f1f27" />
  </svg>
}

function Tree() {
  return <svg viewBox="0 0 100 120" className="holiday-art" aria-hidden="true">
    <defs><linearGradient id="tree-green" x1="0" x2="1"><stop offset="0" stopColor="#14502b" /><stop offset=".5" stopColor="#2f9a56" /><stop offset="1" stopColor="#14502b" /></linearGradient></defs>
    <rect x="44" y="100" width="12" height="16" fill="#6b4226" />
    <path d="M50 38 L82 70 H18 Z" fill="url(#tree-green)" />
    <path d="M50 58 L88 92 H12 Z" fill="url(#tree-green)" />
    <path d="M50 78 L94 108 H6 Z" fill="url(#tree-green)" />
    <path d="M50 8 L54.5 20 L67 20.5 L57 28.5 L60.5 41 L50 33.5 L39.5 41 L43 28.5 L33 20.5 L45.5 20 Z" fill="#ffd34d" className="tree-star" />
    <circle cx="38" cy="62" r="3.4" fill="#ff5a5f" className="tree-bulb" />
    <circle cx="60" cy="52" r="3.2" fill="#6ab7ff" className="tree-bulb tree-bulb-b" />
    <circle cx="30" cy="88" r="3.6" fill="#ffd34d" className="tree-bulb tree-bulb-c" />
    <circle cx="52" cy="82" r="3.6" fill="#ff5a5f" className="tree-bulb tree-bulb-b" />
    <circle cx="72" cy="94" r="3.6" fill="#6ab7ff" className="tree-bulb" />
    <circle cx="66" cy="72" r="3.2" fill="#ffd34d" className="tree-bulb tree-bulb-c" />
    <circle cx="44" cy="102" r="3.2" fill="#ff5a5f" className="tree-bulb tree-bulb-b" />
  </svg>
}

function Gingerbread() {
  return <svg viewBox="0 0 100 120" className="holiday-art" aria-hidden="true">
    <g stroke="#c98b4b" strokeLinecap="round" fill="#c98b4b">
      <line x1="50" y1="52" x2="14" y2="42" strokeWidth="14" />
      <line x1="50" y1="52" x2="86" y2="42" strokeWidth="14" />
      <line x1="42" y1="76" x2="28" y2="104" strokeWidth="15" />
      <line x1="58" y1="76" x2="72" y2="104" strokeWidth="15" />
      <ellipse cx="50" cy="62" rx="19" ry="26" stroke="none" />
      <circle cx="50" cy="24" r="18" stroke="none" />
    </g>
    <g stroke="#fff6e8" strokeWidth="3" strokeLinecap="round" fill="none">
      <path d="M8 40 L14 43 M92 40 L86 43 M24 100 L32 106 M76 100 L68 106" />
      <path d="M42 30 Q50 37 58 30" />
    </g>
    <circle cx="43" cy="21" r="2.4" fill="#fff6e8" />
    <circle cx="57" cy="21" r="2.4" fill="#fff6e8" />
    <circle cx="50" cy="52" r="3.4" fill="#d32f2f" />
    <circle cx="50" cy="64" r="3.4" fill="#2f9a56" />
    <circle cx="50" cy="76" r="3.4" fill="#d32f2f" />
  </svg>
}

function Wreath() {
  return <svg viewBox="0 0 100 120" className="holiday-art" aria-hidden="true">
    <circle cx="50" cy="58" r="34" fill="none" stroke="#1f6b3a" strokeWidth="18" />
    <circle cx="50" cy="58" r="34" fill="none" stroke="#3fae68" strokeWidth="10" strokeDasharray="5 4" />
    <circle cx="26" cy="40" r="3.4" fill="#d32f2f" />
    <circle cx="74" cy="76" r="3.4" fill="#d32f2f" />
    <circle cx="76" cy="38" r="3" fill="#d32f2f" />
    <circle cx="30" cy="78" r="3" fill="#d32f2f" />
    <path d="M50 88 L34 112 L44 106 L50 116 L56 106 L66 112 Z" fill="#c8332f" />
    <path d="M50 92 L36 80 Q40 74 50 90 Q60 74 64 80 Z" fill="#d93a35" />
    <circle cx="50" cy="90" r="5" fill="#a82723" />
  </svg>
}

const ICON_VISITORS = { gift: Gift, 'candy-cane': CandyCane, bell: Bell } as const

function VisitorArt({ kind }: { kind: HolidayVisitor }) {
  if (kind === 'snowman') return <Snowman />
  if (kind === 'tree') return <Tree />
  if (kind === 'gingerbread') return <Gingerbread />
  if (kind === 'wreath') return <Wreath />
  const Icon = ICON_VISITORS[kind]
  return <Icon className="holiday-icon" strokeWidth={1.1} />
}

export function HolidayScene() {
  const lights = useMemo(stringLights, [])
  const flakes = useMemo(() => Array.from({ length: FLAKES }, (_, index) => ({
    size: 2.5 + rand(index, 1) * 6.5,
    left: rand(index, 2) * 100,
    duration: 9 + rand(index, 3) * 14,
    delay: -rand(index, 4) * 24,
    sway: (rand(index, 5) - 0.5) * 90,
    opacity: 0.35 + rand(index, 6) * 0.55,
  })), [])
  const bigFlakes = useMemo(() => Array.from({ length: BIG_FLAKES }, (_, index) => ({
    size: 22 + rand(index, 7) * 14,
    left: 4 + rand(index, 8) * 90,
    duration: 26 + rand(index, 9) * 18,
    delay: -rand(index, 10) * 40,
    sway: (rand(index, 11) - 0.5) * 120,
  })), [])
  const [visit, setVisit] = useState({ left: '50%', top: '52%', index: 0 })
  const visitor = holidayVisitors[visit.index]

  return <>
    <div className="holiday-sky" />
    <div className="holiday-star" />
    <div className="holiday-sleigh"><Sleigh /></div>
    {flakes.map((flake, index) => <span className="snowflake" key={index} style={{
      '--flake-size': `${flake.size}px`, '--flake-left': `${flake.left}%`, '--flake-duration': `${flake.duration}s`,
      '--flake-delay': `${flake.delay}s`, '--flake-sway': `${flake.sway}px`, '--flake-opacity': flake.opacity,
    } as CSSProperties} />)}
    {bigFlakes.map((flake, index) => <span className="snowflake-big" key={index} style={{
      '--flake-left': `${flake.left}%`, '--flake-duration': `${flake.duration}s`,
      '--flake-delay': `${flake.delay}s`, '--flake-sway': `${flake.sway}px`,
    } as CSSProperties}><Snowflake size={flake.size} strokeWidth={1.3} /></span>)}
    <div className="holiday-visitor" data-visitor={visitor} style={{ left: visit.left, top: visit.top }} onAnimationIteration={() => setVisit((current) => ({
      left: `${34 + Math.random() * 32}%`, top: `${36 + Math.random() * 28}%`,
      index: (current.index + 1) % holidayVisitors.length,
    }))}><VisitorArt kind={visitor} /></div>
    <div className="holiday-drift" />
    <div className="holiday-lights">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none"><path d={lights.path} /></svg>
      {lights.bulbs.map((bulb, index) => <span className="holiday-bulb" key={index} style={{
        left: `${bulb.x}%`, top: `${bulb.y}px`, '--bulb-color': bulb.color, '--bulb-delay': `${-(index % 7) * 0.45}s`,
      } as CSSProperties} />)}
    </div>
  </>
}
