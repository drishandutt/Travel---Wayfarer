import type { CSSProperties } from 'react'

// Memphis-style confetti: flat geometric shapes scattered behind a headline or card.
// Purely decorative, so it's hidden from assistive tech and never takes clicks.

type Kind = 'squiggle' | 'circle' | 'ring' | 'triangle' | 'dots' | 'zigzag' | 'half' | 'cross'
type Piece = [Kind, string, CSSProperties] // shape, colour, where

const C = { y: 'var(--m-yellow)', p: 'var(--m-pink)', t: 'var(--m-teal)', v: 'var(--m-violet)', o: 'var(--m-orange)', b: 'var(--m-blue)' }

const LAYOUTS: Record<string, Piece[]> = {
  // the intake headline, bottom right of the map
  hero: [
    ['squiggle', C.p, { right: '62%', top: '-34px', width: 92, rotate: '-12deg' }],
    ['circle', C.y, { right: '-26px', top: '-30px', width: 46 }],
    ['triangle', C.t, { right: '38%', top: '-58px', width: 40, rotate: '18deg' }],
    ['dots', C.v, { left: '-30px', top: '30%', width: 60 }],
    ['zigzag', C.o, { right: '4%', bottom: '-30px', width: 78 }],
    ['ring', C.b, { left: '8%', bottom: '-18px', width: 30 }],
  ],
  // around a centred card (sign-in, invites)
  card: [
    ['circle', C.y, { left: '-34px', top: '-30px', width: 72 }],
    ['squiggle', C.p, { right: '-48px', top: '18%', width: 96, rotate: '78deg' }],
    ['triangle', C.t, { left: '-46px', bottom: '14%', width: 52, rotate: '-14deg' }],
    ['dots', C.v, { right: '-38px', bottom: '-34px', width: 72 }],
    ['zigzag', C.o, { left: '30%', bottom: '-40px', width: 84 }],
    ['half', C.b, { right: '24%', top: '-30px', width: 54, rotate: '180deg' }],
  ],
  // a small cluster tucked in a corner
  corner: [
    ['circle', C.y, { right: '22px', top: '20px', width: 34 }],
    ['triangle', C.t, { right: '70px', top: '26px', width: 28, rotate: '20deg' }],
    ['squiggle', C.p, { right: '24px', top: '68px', width: 70, rotate: '-8deg' }],
    ['cross', C.v, { right: '112px', top: '16px', width: 20 }],
  ],
  // a quiet sprinkle behind an empty or finished state
  sprinkle: [
    ['squiggle', C.p, { left: '10%', top: '12%', width: 70, rotate: '-10deg' }],
    ['circle', C.y, { right: '12%', top: '16%', width: 28 }],
    ['triangle', C.t, { left: '14%', bottom: '16%', width: 30, rotate: '12deg' }],
    ['dots', C.v, { right: '10%', bottom: '12%', width: 52 }],
  ],
}

function Shape({ kind, color }: { kind: Kind; color: string }) {
  const line = { fill: 'none', stroke: color, strokeWidth: 5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  switch (kind) {
    case 'squiggle': return <svg viewBox="0 0 68 22"><path d="M3 11 Q 11 1 19 11 T 35 11 T 51 11 T 65 11" {...line} /></svg>
    case 'circle': return <svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill={color} stroke="var(--m-ink)" strokeWidth="2.5" /></svg>
    case 'ring': return <svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="15" {...line} /></svg>
    case 'triangle': return <svg viewBox="0 0 40 36"><polygon points="20,3 37,33 3,33" fill={color} stroke="var(--m-ink)" strokeWidth="2.5" strokeLinejoin="round" /></svg>
    case 'half': return <svg viewBox="0 0 40 22"><path d="M2 20 A 18 18 0 0 1 38 20 Z" fill={color} stroke="var(--m-ink)" strokeWidth="2.5" /></svg>
    case 'cross': return <svg viewBox="0 0 20 20"><path d="M10 2 V18 M2 10 H18" {...line} strokeWidth={4.5} /></svg>
    case 'zigzag': return <svg viewBox="0 0 70 20"><polyline points="3,16 13,4 23,16 33,4 43,16 53,4 63,16" {...line} /></svg>
    case 'dots': return (
      <svg viewBox="0 0 40 40">
        {Array.from({ length: 16 }, (_, i) => <circle key={i} cx={5 + (i % 4) * 10} cy={5 + Math.floor(i / 4) * 10} r="2.6" fill={color} />)}
      </svg>
    )
  }
}

export function Memphis({ layout }: { layout: keyof typeof LAYOUTS }) {
  return (
    <div className={`mph mph-${layout}`} aria-hidden>
      {LAYOUTS[layout].map(([kind, color, { width, rotate, ...at }], i) => (
        <span key={i} className="mph-s" style={{ ...at, width, ['--r' as string]: rotate ?? '0deg', animationDelay: `${i * -1.3}s` }}>
          <Shape kind={kind} color={color} />
        </span>
      ))}
    </div>
  )
}
