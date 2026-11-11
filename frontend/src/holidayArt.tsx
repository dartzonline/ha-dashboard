import type { ReactNode } from 'react'
import { Bell, CandyCane, Gift } from 'lucide-react'
import type { Motion } from './seasonalPlay'

export const holidayVisitors = [
  'snowman', 'tree', 'gingerbread', 'wreath', 'gift', 'candy-cane', 'bell',
  'santa', 'reindeer', 'penguin', 'nutcracker', 'snow-globe', 'cocoa', 'stocking',
] as const
export type HolidayVisitor = typeof holidayVisitors[number]

export const holidayMotion: Record<HolidayVisitor, Motion> = {
  snowman: 'slide', tree: 'drop', gingerbread: 'hop', wreath: 'swing', gift: 'drop', 'candy-cane': 'swing', bell: 'swing',
  santa: 'float', reindeer: 'hop', penguin: 'slide', nutcracker: 'hop', 'snow-globe': 'drop', cocoa: 'float', stocking: 'swing',
}

export function Reindeer({ x, lead }: { x: number; lead?: boolean }) {
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

export function Sleigh() {
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

/** A wrapped present; used for the gifts that parachute down from the sleigh. */
export function Present({ color = '#c8332f', ribbon = '#ffd166' }: { color?: string; ribbon?: string }) {
  return <svg viewBox="0 0 40 56" aria-hidden="true" className="present-art">
    <path d="M20 22 L4 4 M20 22 L36 4" stroke="#e8e2d0" strokeWidth="1" />
    <path d="M2 6 Q20 -6 38 6 Q20 0 2 6 Z" fill="#f4f1e7" />
    <rect x="6" y="22" width="28" height="28" rx="3" fill={color} />
    <rect x="17" y="22" width="6" height="28" fill={ribbon} />
    <rect x="6" y="33" width="28" height="6" fill={ribbon} />
    <path d="M20 22 Q12 14 14 22 Q16 26 20 22 Q28 14 26 22 Q24 26 20 22 Z" fill={ribbon} />
  </svg>
}

const art = (children: ReactNode) => <svg viewBox="0 0 100 120" className="holiday-art" aria-hidden="true">{children}</svg>

function Snowman() {
  return art(<>
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
  </>)
}

function Tree() {
  return art(<>
    <defs><linearGradient id="tree-green" x1="0" x2="1"><stop offset="0" stopColor="#14502b" /><stop offset=".5" stopColor="#2f9a56" /><stop offset="1" stopColor="#14502b" /></linearGradient></defs>
    <rect x="44" y="100" width="12" height="16" fill="#6b4226" />
    <path d="M50 38 L82 70 H18 Z" fill="url(#tree-green)" />
    <path d="M50 58 L88 92 H12 Z" fill="url(#tree-green)" />
    <path d="M50 78 L94 108 H6 Z" fill="url(#tree-green)" />
    <path d="M24 66 Q50 76 76 64 M18 90 Q50 100 82 88" stroke="#ffd34d" strokeWidth="1.6" fill="none" opacity=".8" />
    <path d="M50 8 L54.5 20 L67 20.5 L57 28.5 L60.5 41 L50 33.5 L39.5 41 L43 28.5 L33 20.5 L45.5 20 Z" fill="#ffd34d" className="tree-star" />
    <circle cx="38" cy="62" r="3.4" fill="#ff5a5f" className="tree-bulb" />
    <circle cx="60" cy="52" r="3.2" fill="#6ab7ff" className="tree-bulb tree-bulb-b" />
    <circle cx="30" cy="88" r="3.6" fill="#ffd34d" className="tree-bulb tree-bulb-c" />
    <circle cx="52" cy="82" r="3.6" fill="#ff5a5f" className="tree-bulb tree-bulb-b" />
    <circle cx="72" cy="94" r="3.6" fill="#6ab7ff" className="tree-bulb" />
    <circle cx="66" cy="72" r="3.2" fill="#ffd34d" className="tree-bulb tree-bulb-c" />
    <circle cx="44" cy="102" r="3.2" fill="#ff5a5f" className="tree-bulb tree-bulb-b" />
  </>)
}

function Gingerbread() {
  return art(<>
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
  </>)
}

function Wreath() {
  return art(<>
    <circle cx="50" cy="58" r="34" fill="none" stroke="#1f6b3a" strokeWidth="18" />
    <circle cx="50" cy="58" r="34" fill="none" stroke="#3fae68" strokeWidth="10" strokeDasharray="5 4" />
    <circle cx="26" cy="40" r="3.4" fill="#d32f2f" />
    <circle cx="74" cy="76" r="3.4" fill="#d32f2f" />
    <circle cx="76" cy="38" r="3" fill="#d32f2f" />
    <circle cx="30" cy="78" r="3" fill="#d32f2f" />
    <path d="M50 88 L34 112 L44 106 L50 116 L56 106 L66 112 Z" fill="#c8332f" />
    <path d="M50 92 L36 80 Q40 74 50 90 Q60 74 64 80 Z" fill="#d93a35" />
    <circle cx="50" cy="90" r="5" fill="#a82723" />
  </>)
}

function Santa() {
  return art(<>
    <line x1="32" y1="72" x2="22" y2="98" stroke="#c8332f" strokeWidth="10" strokeLinecap="round" />
    <circle cx="21" cy="100" r="5.5" fill="#f4f1e7" />
    <path d="M26 70 Q50 56 74 70 L80 112 H20 Z" fill="#c8332f" />
    <rect x="20" y="106" width="60" height="9" rx="3" fill="#f4f1e7" />
    <rect x="47" y="64" width="6" height="42" fill="#f4f1e7" />
    <rect x="24" y="84" width="52" height="7" fill="#1f1f27" />
    <rect x="44" y="82.5" width="12" height="10" rx="1.5" fill="none" stroke="#f0c75e" strokeWidth="2.4" />
    <g className="santa-wave">
      <line x1="68" y1="72" x2="86" y2="48" stroke="#c8332f" strokeWidth="10" strokeLinecap="round" />
      <circle cx="88" cy="44" r="6" fill="#f4f1e7" />
    </g>
    <circle cx="50" cy="44" r="14" fill="#f2c9a5" />
    <path d="M34 46 Q50 80 66 46 Q58 56 50 54 Q42 56 34 46 Z" fill="#f4f1e7" />
    <ellipse cx="44" cy="52" rx="6" ry="3" fill="#f4f1e7" />
    <ellipse cx="56" cy="52" rx="6" ry="3" fill="#f4f1e7" />
    <circle cx="50" cy="49" r="2.6" fill="#e89a7a" />
    <circle cx="44.5" cy="42" r="1.7" fill="#1f1f27" />
    <circle cx="55.5" cy="42" r="1.7" fill="#1f1f27" />
    <path d="M36 34 Q44 8 72 14 L66 34 Z" fill="#c8332f" />
    <rect x="34" y="31" width="34" height="7" rx="3.5" fill="#f4f1e7" />
    <circle cx="73" cy="15" r="5" fill="#f4f1e7" />
  </>)
}

function StandingReindeer() {
  return art(<g transform="translate(26 12) scale(1.15)"><Reindeer x={0} lead /></g>)
}

function Penguin() {
  return art(<>
    <ellipse cx="22" cy="74" rx="7" ry="18" transform="rotate(18 22 74)" fill="#1f2430" />
    <ellipse cx="78" cy="74" rx="7" ry="18" transform="rotate(-18 78 74)" fill="#1f2430" />
    <ellipse cx="50" cy="72" rx="26" ry="38" fill="#262c3a" />
    <ellipse cx="50" cy="80" rx="17" ry="27" fill="#f4f6fa" />
    <ellipse cx="40" cy="110" rx="9" ry="4" fill="#ef8a2a" />
    <ellipse cx="60" cy="110" rx="9" ry="4" fill="#ef8a2a" />
    <circle cx="42" cy="46" r="4.2" fill="#fff" /><circle cx="43" cy="46" r="2" fill="#111" />
    <circle cx="58" cy="46" r="4.2" fill="#fff" /><circle cx="57" cy="46" r="2" fill="#111" />
    <path d="M45 53 L55 53 L50 60 Z" fill="#ef8a2a" />
    <path d="M28 62 Q50 70 72 62 L72 68 Q50 76 28 68 Z" fill="#c8332f" />
    <path d="M62 66 L68 82 L60 80 Z" fill="#a82723" />
    <path d="M30 38 Q50 6 70 38 Z" fill="#2f9a56" />
    <rect x="28" y="34" width="44" height="7" rx="3.5" fill="#f4f1e7" />
    <circle cx="50" cy="14" r="5" fill="#f4f1e7" />
  </>)
}

function Nutcracker() {
  return art(<>
    <rect x="36" y="2" width="28" height="28" rx="3" fill="#1f1f27" />
    <rect x="36" y="22" width="28" height="5" fill="#f0c75e" />
    <path d="M50 6 L53 12 L50 18 L47 12 Z" fill="#f0c75e" />
    <rect x="36" y="30" width="28" height="22" fill="#f2c9a5" />
    <path d="M34 32 Q30 46 36 54 M66 32 Q70 46 64 54" stroke="#f4f1e7" strokeWidth="5" fill="none" strokeLinecap="round" />
    <circle cx="44" cy="38" r="1.9" fill="#1f1f27" /><circle cx="56" cy="38" r="1.9" fill="#1f1f27" />
    <circle cx="41" cy="44" r="2.6" fill="#ef8b8b" /><circle cx="59" cy="44" r="2.6" fill="#ef8b8b" />
    <rect x="42" y="45" width="16" height="8" rx="1" fill="#f4f1e7" />
    <path d="M46 45 V53 M50 45 V53 M54 45 V53" stroke="#c7bfae" strokeWidth="1" />
    <rect x="30" y="54" width="40" height="36" rx="4" fill="#c8332f" />
    <rect x="22" y="56" width="10" height="28" rx="5" fill="#2f5fb3" />
    <rect x="68" y="56" width="10" height="28" rx="5" fill="#2f5fb3" />
    <rect x="30" y="76" width="40" height="5" fill="#1f1f27" />
    <circle cx="50" cy="62" r="1.8" fill="#f0c75e" /><circle cx="50" cy="69" r="1.8" fill="#f0c75e" />
    <path d="M30 56 L50 66 L70 56" stroke="#f0c75e" strokeWidth="1.6" fill="none" />
    <rect x="35" y="90" width="12" height="20" fill="#f4f1e7" />
    <rect x="53" y="90" width="12" height="20" fill="#f4f1e7" />
    <rect x="33" y="106" width="16" height="10" rx="3" fill="#1f1f27" />
    <rect x="51" y="106" width="16" height="10" rx="3" fill="#1f1f27" />
  </>)
}

function SnowGlobe() {
  return art(<>
    <defs><clipPath id="globe-clip"><circle cx="50" cy="56" r="37" /></clipPath></defs>
    <circle cx="50" cy="56" r="40" fill="rgba(170, 214, 255, .16)" stroke="rgba(235, 246, 255, .7)" strokeWidth="2.4" />
    <g clipPath="url(#globe-clip)">
      <ellipse cx="50" cy="94" rx="44" ry="14" fill="#f4f8fb" />
      <path d="M50 40 L66 70 H34 Z" fill="#2f9a56" />
      <path d="M50 54 L70 84 H30 Z" fill="#1f7a42" />
      <rect x="47" y="84" width="6" height="7" fill="#6b4226" />
      <path d="M50 34 L52 39 L57 39 L53 42 L55 47 L50 44 L45 47 L47 42 L43 39 L48 39 Z" fill="#ffd34d" />
      <g className="globe-snow">
        {[[26, 30], [40, 22], [62, 26], [74, 40], [32, 52], [68, 58], [58, 40], [22, 66], [80, 68], [44, 68]].map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" fill="#fff" />)}
      </g>
    </g>
    <path d="M28 34 Q36 22 50 20" stroke="rgba(255, 255, 255, .7)" strokeWidth="3" fill="none" strokeLinecap="round" />
    <path d="M22 96 H78 L72 116 H28 Z" fill="#7a4b2a" />
    <rect x="22" y="96" width="56" height="5" fill="#f0c75e" />
  </>)
}

function Cocoa() {
  return art(<>
    <g className="cocoa-steam" stroke="rgba(255, 255, 255, .7)" strokeWidth="3" fill="none" strokeLinecap="round">
      <path d="M36 40 Q30 30 36 20 Q42 10 36 2" />
      <path d="M50 38 Q44 28 50 18 Q56 8 50 0" />
      <path d="M64 40 Q58 30 64 20 Q70 10 64 2" />
    </g>
    <path d="M74 62 Q94 62 92 80 Q90 98 72 96" stroke="#c8332f" strokeWidth="8" fill="none" />
    <rect x="22" y="48" width="54" height="62" rx="10" fill="#c8332f" />
    <path d="M22 66 H76 M22 92 H76" stroke="#f4f1e7" strokeWidth="5" />
    <path d="M40 79 L44 75 L48 79 L44 83 Z M52 79 L56 75 L60 79 L56 83 Z" fill="#f4f1e7" />
    <ellipse cx="49" cy="50" rx="25" ry="6" fill="#6b3a20" />
    <rect x="34" y="42" width="11" height="9" rx="3" fill="#fbf5ec" />
    <rect x="47" y="40" width="11" height="9" rx="3" fill="#fbf5ec" transform="rotate(12 52 44)" />
    <rect x="58" y="43" width="10" height="8" rx="3" fill="#fbf5ec" />
  </>)
}

function Stocking() {
  return art(<>
    <rect x="44" y="-4" width="18" height="14" rx="2" fill="#2f9a56" />
    <rect x="51" y="-4" width="4" height="14" fill="#ffd166" />
    <path d="M30 6 L22 -6" stroke="#ff7a85" strokeWidth="5" strokeLinecap="round" />
    <path d="M34 20 H68 V70 Q68 82 78 88 Q92 96 86 108 Q80 118 64 112 L40 100 Q30 94 34 80 Z" fill="#c8332f" />
    <path d="M64 112 Q80 118 86 108 Q90 100 82 92 Q72 100 64 112 Z" fill="#f4f1e7" />
    <path d="M34 80 Q30 94 40 100 L46 92 Q38 88 34 80 Z" fill="#f4f1e7" />
    <path d="M38 40 H64 M38 52 H64" stroke="#2f9a56" strokeWidth="3" />
    <rect x="30" y="8" width="42" height="16" rx="5" fill="#f4f1e7" />
  </>)
}

const ICON_VISITORS = { gift: Gift, 'candy-cane': CandyCane, bell: Bell } as const

export function HolidayVisitorArt({ kind }: { kind: HolidayVisitor }) {
  switch (kind) {
    case 'snowman': return <Snowman />
    case 'tree': return <Tree />
    case 'gingerbread': return <Gingerbread />
    case 'wreath': return <Wreath />
    case 'santa': return <Santa />
    case 'reindeer': return <StandingReindeer />
    case 'penguin': return <Penguin />
    case 'nutcracker': return <Nutcracker />
    case 'snow-globe': return <SnowGlobe />
    case 'cocoa': return <Cocoa />
    case 'stocking': return <Stocking />
    default: {
      const Icon = ICON_VISITORS[kind]
      return <Icon className="holiday-icon" strokeWidth={1.1} />
    }
  }
}
