import { useEffect, useRef, useState } from 'react'
import type { Phase, SavedTrip, TripState } from '../state/tripStore'
import { cityById } from '../data/cities'
import type { BrainStatus } from '../planner/brain'
import type { Theme } from '../state/theme'
import { fmtMoney } from '../money/currency'
import type { GroupSummary } from '../money/types'
import { groupCopyOf } from '../state/persistence'
import { MoonIcon, SunIcon } from './Icons'

const STEPS: { id: Phase; label: string }[] = [
  { id: 'intake', label: 'Brief' },
  { id: 'swipe', label: 'Pick' },
  { id: 'planning', label: 'Mapping' },
  { id: 'review', label: 'Review' },
  { id: 'hotels', label: 'Hotel' },
  { id: 'final', label: 'Trip' },
]

interface Props {
  state: TripState
  brain: BrainStatus | null
  trips: SavedTrip[]
  onOpen: (trip: SavedTrip) => void
  onDelete: (id: string) => void
  theme: Theme
  onToggleTheme: () => void
  onMoney: () => void
  moneyBadge: { net: number; currency: string } | null
  groups: GroupSummary[]
  activeGroup: string | null
  onOpenGroup: (id: string) => void
  onNewTrip: () => void
  email: string | null
  onSignOut: () => void
}

function TripsMenu({ trips, current, onOpen, onDelete, groups, activeGroup, onOpenGroup, onNewTrip, email, onSignOut }: { trips: SavedTrip[]; current?: string } & Pick<Props, 'onOpen' | 'onDelete' | 'groups' | 'activeGroup' | 'onOpenGroup' | 'onNewTrip' | 'email' | 'onSignOut'>) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // A trip you run for a group is listed as the group. Anything else stays reachable on its
  // own: a group that's gone, one someone else runs, or an older copy.
  const mine = trips.filter(t => {
    const g = groups.find(x => x.id === t.brief.moneyGroupId)
    return !(g?.role === 'owner' && groupCopyOf(trips, g.id)?.id === t.id)
  })
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="trips" ref={ref}>
      <button className="trips-btn" onClick={() => setOpen(o => !o)}>My trips <b>{groups.length + mine.length}</b></button>
      {open && (
        <div className="trips-menu">
          <button className="trip-new" onClick={() => { onNewTrip(); setOpen(false) }}>New trip</button>
          {groups.length > 0 && <h4 className="trips-head">Shared</h4>}
          {groups.map(g => (
            <div key={g.id} className={`trip-row ${g.id === activeGroup ? 'on' : ''}`}>
              <button className="open" onClick={() => { onOpenGroup(g.id); setOpen(false) }}>
                <b>{g.name}</b>
                <small>{g.memberCount} {g.memberCount === 1 ? 'person' : 'people'}{g.role === 'owner' ? ' · Admin' : ''}</small>
              </button>
            </div>
          ))}
          {groups.length > 0 && mine.length > 0 && <h4 className="trips-head">Personal</h4>}
          {groups.length === 0 && mine.length === 0 && <p className="empty">No saved trips yet.</p>}
          {mine.map(t => (
            <div key={t.id} className={`trip-row ${t.id === current ? 'on' : ''}`}>
              <button className="open" onClick={() => { onOpen(t); setOpen(false) }}>
                <b>{t.name}</b>
                <small>{t.days.reduce((n, d) => n + d.stops.length, 0)} stops · {new Date(t.savedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</small>
              </button>
              <button className="del" aria-label={`Delete ${t.name}`} onClick={() => { if (confirm(`Delete “${t.name}”?`)) onDelete(t.id) }}>✕</button>
            </div>
          ))}
          {email && (
            <div className="trips-account">
              <small>{email}</small>
              <button onClick={() => { setOpen(false); onSignOut() }}>Sign out</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function TopBar({ state, brain, trips, onOpen, onDelete, theme, onToggleTheme, onMoney, moneyBadge, groups, activeGroup, onOpenGroup, onNewTrip, email, onSignOut }: Props) {
  const b = state.brief
  const city = cityById(b.destination)
  const at = STEPS.findIndex(s => s.id === state.phase)
  // the brief so far, as one line: only what's been decided
  const brief = [
    city?.name,
    b.days && `${b.days} day${b.days > 1 ? 's' : ''}`,
    b.travelers && (b.travelers === 1 ? 'Solo' : `${b.travelers} people`),
    b.budgetAmount ? `$${b.budgetAmount.toLocaleString()}` : undefined,
  ].filter(Boolean) as string[]
  return (
    <header className="topbar">
      <div className="brand">
        <span className="mark">◐</span>
        <span>Wayfarer</span>
        {brain && (
          <span className={`brain ${brain.claude ? 'on' : ''}`} role="img"
            aria-label={brain.claude ? `Planning with ${brain.model?.replace('claude-', 'Claude ').replace(/-(\d)-(\d)$/, ' $1.$2')}` : 'Offline planner'}
            title={brain.claude ? `Planning with ${brain.model?.replace('claude-', 'Claude ').replace(/-(\d)-(\d)$/, ' $1.$2')}` : 'No ANTHROPIC_API_KEY on the server: using the offline planner'} />
        )}
        <TripsMenu trips={trips} current={state.tripId} onOpen={onOpen} onDelete={onDelete} groups={groups} activeGroup={activeGroup} onOpenGroup={onOpenGroup} onNewTrip={onNewTrip} email={email} onSignOut={onSignOut} />
        <button className="money-btn" onClick={onMoney} aria-label={moneyBadge ? `Money: ${moneyBadge.net > 0 ? 'you are owed' : 'you owe'} ${fmtMoney(Math.abs(moneyBadge.net), moneyBadge.currency)}` : 'Money'}>
          Money
          {moneyBadge && <span className={`money-amt ${moneyBadge.net > 0 ? 'pos' : 'neg'}`}>{moneyBadge.net > 0 ? '+' : '−'}{fmtMoney(Math.abs(moneyBadge.net), moneyBadge.currency, { compact: true })}</span>}
        </button>
        <button className="theme-btn" onClick={onToggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
      {/* phones: the full stepper doesn't fit, so show where you are in one line */}
      <span className="step-mini"><i>{at + 1}/{STEPS.length}</i>{STEPS[at]?.label}</span>
      <ol className="stepper">
        {STEPS.map((s, i) => (
          <li key={s.id} className={i < at ? 'done' : i === at ? 'now' : ''}>
            {s.label}
          </li>
        ))}
      </ol>
      <div className="brief">{brief.map(v => <span key={v}>{v}</span>)}</div>
    </header>
  )
}
