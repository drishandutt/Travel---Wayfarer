import { useEffect, useRef, useState, type ReactNode } from 'react'

// Phone layout: the map fills the screen and one bottom sheet holds the panels
// as tabs. Drag the handle between three heights, or tap a tab.

export type Snap = 'peek' | 'half' | 'full'

export interface SheetTab {
  id: string
  label: string
  icon: ReactNode
  badge?: string | number
  dot?: boolean             // something new in a tab you're not looking at
  live?: boolean            // planner is working
  content: ReactNode
}

export function useIsMobile(query = '(max-width: 760px)') {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setMobile(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return mobile
}

// Heights in px for the current screen; "full" stops below the top bar.
export function sheetHeights(vh = window.innerHeight): Record<Snap, number> {
  return { peek: 148, half: Math.round(vh * 0.5), full: vh - 64 }
}

function useViewportHeight() {
  const [vh, setVh] = useState(() => window.visualViewport?.height ?? window.innerHeight)
  useEffect(() => {
    const on = () => setVh(window.visualViewport?.height ?? window.innerHeight)
    window.addEventListener('resize', on)
    window.visualViewport?.addEventListener('resize', on)
    return () => { window.removeEventListener('resize', on); window.visualViewport?.removeEventListener('resize', on) }
  }, [])
  return vh
}

interface Props {
  tabs: SheetTab[]
  active: string
  onTab: (id: string) => void
  snap: Snap
  onSnap: (s: Snap) => void
}

export function MobileSheet({ tabs, active, onTab, snap, onSnap }: Props) {
  const vh = useViewportHeight()
  const heights = sheetHeights(vh)
  const [drag, setDrag] = useState<number | null>(null)
  const start = useRef<{ y: number; h: number; t: number; moved: boolean } | null>(null)

  const onDown = (e: React.PointerEvent) => {
    start.current = { y: e.clientY, h: heights[snap], t: performance.now(), moved: false }
    // capture only once it's really a drag (in onMove), so taps still reach the tab buttons
  }
  const onMove = (e: React.PointerEvent) => {
    const s = start.current
    if (!s) return
    const dy = e.clientY - s.y
    if (!s.moved && Math.abs(dy) > 6) {
      s.moved = true
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
    }
    if (s.moved) setDrag(Math.max(96, Math.min(heights.full, s.h - dy)))
  }
  const onUp = (e: React.PointerEvent) => {
    const s = start.current
    start.current = null
    if (!s || !s.moved) { setDrag(null); return }
    // project a flick forward a little, then settle on the nearest height
    const v = (s.y - e.clientY) / Math.max(1, performance.now() - s.t) // px/ms, + = upward
    const target = (drag ?? heights[snap]) + v * 180
    const nearest = (Object.keys(heights) as Snap[]).reduce((a, b) => (Math.abs(heights[b] - target) < Math.abs(heights[a] - target) ? b : a))
    setDrag(null)
    onSnap(nearest)
  }

  const tapTab = (id: string) => {
    if (id === active) onSnap(snap === 'peek' ? 'half' : snap === 'half' ? 'full' : 'half')
    else { onTab(id); if (snap === 'peek') onSnap('half') }
  }

  const current = tabs.find(t => t.id === active) ?? tabs[0]
  return (
    <section className={`sheet snap-${snap} ${drag !== null ? 'dragging' : ''}`} style={{ height: drag ?? heights[snap] }} aria-label="Trip panel">
      <div className="sheet-grab" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { start.current = null; setDrag(null) }}>
        <button className="sheet-handle" aria-label={snap === 'full' ? 'Shrink panel' : 'Expand panel'} onClick={() => onSnap(snap === 'full' ? 'half' : 'full')}><i /></button>
        {tabs.length > 1 && (
          <nav className="sheet-tabs" role="tablist">
            {tabs.map(t => (
              <button key={t.id} role="tab" aria-selected={t.id === current.id} className={t.id === current.id ? 'on' : ''} onClick={() => tapTab(t.id)}>
                {t.live ? <i className="orb live" /> : t.icon}
                <span>{t.label}</span>
                {t.badge !== undefined && t.badge !== '' && <b>{t.badge}</b>}
                {t.dot && t.id !== current.id && <i className="dot" />}
              </button>
            ))}
          </nav>
        )}
      </div>
      <div className="sheet-body">{current.content}</div>
    </section>
  )
}
