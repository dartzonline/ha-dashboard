import type { ReactNode } from 'react'
import type { Motion } from './seasonalPlay'

export const fallVisitors = ['turkey', 'owl', 'acorn', 'mushroom', 'apple', 'pie'] as const
export type FallVisitor = typeof fallVisitors[number]

export const fallMotion: Record<FallVisitor, Motion> = {
  turkey: 'hop', owl: 'float', acorn: 'drop', mushroom: 'slide', apple: 'drop', pie: 'float',
}

export const LEAF_COLORS = ['#d9541e', '#e8862a', '#f2b33d', '#a8401c', '#c96f2b', '#b8862a', '#8f3b1b']

const LEAF_SHAPES = {
  maple: 'M20 2 L23 11 L30 7 L28 16 L37 15 L31 22 L35 26 L25 26 L24 33 L20 29 L16 33 L15 26 L5 26 L9 22 L3 15 L12 16 L10 7 L17 11 Z',
  oak: 'M20 3 C24 6 22 9 26 10 C30 11 29 15 27 17 C31 19 31 23 27 24 C30 27 28 31 24 30 C24 34 21 35 20 37 C19 35 16 34 16 30 C12 31 10 27 13 24 C9 23 9 19 13 17 C11 15 10 11 14 10 C18 9 16 6 20 3 Z',
  birch: 'M20 3 C30 10 32 24 20 37 C8 24 10 10 20 3 Z',
} as const
export const leafShapes = Object.keys(LEAF_SHAPES) as (keyof typeof LEAF_SHAPES)[]

export function Leaf({ shape, color }: { shape: keyof typeof LEAF_SHAPES; color: string }) {
  return <svg viewBox="0 0 40 40" className="leaf-art" aria-hidden="true">
    <path d={LEAF_SHAPES[shape]} fill={color} />
    <path d="M20 8 L20 36 M20 18 L13 13 M20 18 L27 13 M20 26 L14 22 M20 26 L26 22" stroke="rgba(60, 20, 5, .45)" strokeWidth="1" fill="none" />
    <path d="M20 33 L20 39" stroke="#6b3a1a" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
}

export function Geese() {
  const birds = [[110, 10], [92, 20], [74, 30], [56, 40], [128, 20], [146, 30], [164, 40]]
  return <svg viewBox="0 0 220 60" className="geese-art" aria-hidden="true">
    {birds.map(([x, y], index) => <g key={index} transform={`translate(${x} ${y})`}>
      <path className="goose" style={{ animationDelay: `${-index * 0.13}s` }} d="M-10 0 Q-5 -7 0 0 Q5 -7 10 0" stroke="#f1dcc2" strokeWidth="2.4" fill="none" strokeLinecap="round" />
    </g>)}
  </svg>
}

const art = (children: ReactNode) => <svg viewBox="0 0 100 120" className="fall-art" aria-hidden="true">{children}</svg>

function Turkey() {
  const feathers = ['#8f3b1b', '#d9541e', '#e8862a', '#f2b33d', '#e8862a', '#d9541e', '#8f3b1b']
  return art(<>
    {feathers.map((color, index) => <ellipse key={index} cx="50" cy="30" rx="10" ry="30" fill={color} transform={`rotate(${-66 + index * 22} 50 72)`} />)}
    <path d="M42 106 L38 116 M42 106 L44 116 M58 106 L56 116 M58 106 L62 116" stroke="#e8a33a" strokeWidth="3" strokeLinecap="round" />
    <ellipse cx="50" cy="80" rx="22" ry="26" fill="#7a4a2a" />
    <ellipse cx="50" cy="86" rx="13" ry="16" fill="#9a6640" />
    <circle cx="50" cy="52" r="12" fill="#8a5a36" />
    <circle cx="45.5" cy="49" r="2.4" fill="#fff" /><circle cx="45.5" cy="49" r="1.2" fill="#111" />
    <circle cx="54.5" cy="49" r="2.4" fill="#fff" /><circle cx="54.5" cy="49" r="1.2" fill="#111" />
    <path d="M47 54 L53 54 L50 60 Z" fill="#f2b33d" />
    <path d="M52 57 Q57 62 54 68 Q50 64 52 57 Z" fill="#d32f2f" />
  </>)
}

function Owl() {
  return art(<>
    <path d="M10 110 H90" stroke="#5a3a1f" strokeWidth="6" strokeLinecap="round" />
    <path d="M24 34 L30 14 L40 30 Z M76 34 L70 14 L60 30 Z" fill="#6b4226" />
    <ellipse cx="22" cy="72" rx="9" ry="22" fill="#6b4226" />
    <ellipse cx="78" cy="72" rx="9" ry="22" fill="#6b4226" />
    <ellipse cx="50" cy="66" rx="28" ry="40" fill="#8a5a36" />
    <ellipse cx="50" cy="80" rx="18" ry="24" fill="#d9b98a" />
    <path d="M42 74 L46 78 L50 74 L54 78 L58 74 M42 86 L46 90 L50 86 L54 90 L58 86" stroke="#a87b4f" strokeWidth="1.6" fill="none" />
    <circle cx="38" cy="48" r="12" fill="#f4e7c8" /><circle cx="62" cy="48" r="12" fill="#f4e7c8" />
    <g className="owl-eyes">
      <circle cx="38" cy="48" r="6.5" fill="#f2b33d" /><circle cx="62" cy="48" r="6.5" fill="#f2b33d" />
      <circle cx="38" cy="48" r="3.4" fill="#1a120c" /><circle cx="62" cy="48" r="3.4" fill="#1a120c" />
      <circle cx="39.5" cy="46.5" r="1.2" fill="#fff" /><circle cx="63.5" cy="46.5" r="1.2" fill="#fff" />
    </g>
    <path d="M46 58 L54 58 L50 66 Z" fill="#e8862a" />
    <path d="M38 106 L36 112 M42 106 L42 112 M58 106 L58 112 M62 106 L64 112" stroke="#e8a33a" strokeWidth="2.4" strokeLinecap="round" />
  </>)
}

function Acorn() {
  return art(<>
    <defs><linearGradient id="acorn-nut" x1="0" x2="1"><stop offset="0" stopColor="#8a5a2a" /><stop offset=".45" stopColor="#d79b55" /><stop offset="1" stopColor="#7a4a22" /></linearGradient></defs>
    <path d="M28 56 Q26 92 50 112 Q74 92 72 56 Z" fill="url(#acorn-nut)" />
    <path d="M18 58 Q50 18 82 58 Q50 70 18 58 Z" fill="#6b4226" />
    <path d="M26 50 L74 50 M30 42 L70 42 M38 34 L62 34 M34 46 L44 58 M50 44 L50 60 M66 46 L56 58" stroke="#4e2f18" strokeWidth="1.6" />
    <path d="M50 30 Q50 16 60 10" stroke="#5a3a1f" strokeWidth="5" fill="none" strokeLinecap="round" />
    <path d="M60 10 Q78 2 84 18 Q70 22 60 10 Z" fill="#7aa33a" />
    <ellipse cx="40" cy="80" rx="4" ry="12" fill="rgba(255, 230, 190, .35)" />
  </>)
}

function Mushroom() {
  return art(<>
    <path d="M14 112 Q20 100 22 112 M30 112 Q34 98 38 112 M64 112 Q68 100 72 112 M80 112 Q84 96 88 112" stroke="#5f8a3a" strokeWidth="3" fill="none" strokeLinecap="round" />
    <path d="M38 62 H62 Q66 92 64 108 Q50 114 36 108 Q34 92 38 62 Z" fill="#f3e6d0" />
    <path d="M10 64 Q50 2 90 64 Q50 76 10 64 Z" fill="#c8332f" />
    <path d="M18 64 Q50 74 82 64" stroke="#e2cbb0" strokeWidth="4" fill="none" />
    <circle cx="34" cy="42" r="6" fill="#fbf5ec" /><circle cx="56" cy="28" r="5" fill="#fbf5ec" />
    <circle cx="68" cy="48" r="7" fill="#fbf5ec" /><circle cx="48" cy="52" r="3.6" fill="#fbf5ec" />
    <circle cx="22" cy="56" r="3" fill="#fbf5ec" /><circle cx="80" cy="58" r="3" fill="#fbf5ec" />
  </>)
}

function Apple() {
  return art(<>
    <defs><radialGradient id="apple-red" cx="35%" cy="35%" r="75%"><stop offset="0" stopColor="#f0574b" /><stop offset="1" stopColor="#9e1f1a" /></radialGradient></defs>
    <path d="M50 40 C30 22 6 40 12 70 C18 100 38 114 50 106 C62 114 82 100 88 70 C94 40 70 22 50 40 Z" fill="url(#apple-red)" />
    <path d="M50 42 Q48 24 56 14" stroke="#5a3a1f" strokeWidth="5" fill="none" strokeLinecap="round" />
    <path d="M56 22 Q74 10 84 24 Q68 34 56 22 Z" fill="#5f9a3a" />
    <ellipse cx="32" cy="58" rx="6" ry="12" transform="rotate(20 32 58)" fill="rgba(255, 255, 255, .45)" />
  </>)
}

function Pie() {
  return art(<>
    <defs><clipPath id="pie-top"><ellipse cx="50" cy="74" rx="38" ry="13" /></clipPath></defs>
    <g className="pie-steam" stroke="rgba(255, 255, 255, .65)" strokeWidth="3" fill="none" strokeLinecap="round">
      <path d="M36 56 Q30 46 36 36 Q42 26 36 18" /><path d="M52 54 Q46 44 52 34 Q58 24 52 16" /><path d="M66 56 Q60 46 66 36 Q72 26 66 18" />
    </g>
    <ellipse cx="50" cy="92" rx="46" ry="15" fill="#b9c4cc" />
    <path d="M10 76 L14 90 Q50 104 86 90 L90 76 Z" fill="#c98b4b" />
    <ellipse cx="50" cy="75" rx="40" ry="14" fill="#9e3b1e" />
    <g clipPath="url(#pie-top)" stroke="#f2c27d" strokeWidth="5">
      <path d="M24 60 L34 90 M40 60 L50 90 M56 60 L66 90 M72 60 L82 90" />
      <path d="M10 70 H90 M10 80 H90" />
    </g>
    <ellipse cx="50" cy="75" rx="40" ry="14" fill="none" stroke="#e0a35a" strokeWidth="5" />
  </>)
}

export function FallVisitorArt({ kind }: { kind: FallVisitor }) {
  switch (kind) {
    case 'turkey': return <Turkey />
    case 'owl': return <Owl />
    case 'acorn': return <Acorn />
    case 'mushroom': return <Mushroom />
    case 'apple': return <Apple />
    case 'pie': return <Pie />
  }
}
