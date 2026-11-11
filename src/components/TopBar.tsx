import { useEffect, useRef, useState } from 'react'
import type { Phase, SavedTrip, TripState } from '../state/tripStore'
import { cityById } from '../data/cities'
import { modelLabel, plansRemotely, type BrainStatus } from '../planner/brain'
import type { GroupSummary } from '../money/types'
import { groupCopyOf } from '../state/persistence'
import { RestartIcon, ToolsIcon } from './Icons'
import { Avatar } from './money/parts'

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
  onDeleteGroup?: (group: GroupSummary) => void   // an admin deleting a shared trip, for everyone
  onMoney: () => void
  onPhotos: () => void
  onDocs: () => void
  groups: GroupSummary[]
  activeGroup: string | null
  onOpenGroup: (id: string) => void
  onNewTrip: () => void
  // a clean slate; only offered while there's something on screen to clear
  onStartOver?: () => void
  // only for the app's owner
  onDevTools?: () => void
  devReviews?: number           // the owner's finds waiting for review
  email: string | null
  onSignOut: () => void
  onProfile?: () => void
  me?: { id: string; name: string } | null
  alertsUnread?: number
}

// Photos, documents and money, behind one button so the bar stays clear.
const TOOLS = [
  { id: 'photos', icon: '🖼', label: 'Photos', hint: 'Trip photos, shared with who you choose' },
  { id: 'docs', icon: '🧳', label: 'Documents', hint: 'Tickets, bookings, passports, with alerts' },
  { id: 'money', icon: '💸', label: 'Money', hint: 'Expenses and who owes whom' },
] as const

function ToolsMenu({ onMoney, onPhotos, onDocs, alertsUnread = 0 }: Pick<Props, 'onMoney' | 'onPhotos' | 'onDocs' | 'alertsUnread'>) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])
  const go = { photos: onPhotos, docs: onDocs, money: onMoney }
  return (
    <div className="trips tools" ref={ref}>
      <button className="trips-btn tools-btn" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(o => !o)}><ToolsIcon /><span>Tools</span></button>
      {open && (
        <div className="trips-menu tools-menu" role="menu">
          {TOOLS.map(t => (
            <button key={t.id} role="menuitem" className="tool-row" onClick={() => { setOpen(false); go[t.id]() }}>
              <span className="tool-icon" aria-hidden>{t.icon}</span>
              <span><b>{t.label}{t.id === 'docs' && alertsUnread > 0 && <i className="tool-badge">{alertsUnread}</i>}</b><small>{t.hint}</small></span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function TripsMenu({ trips, current, onOpen, onDelete, onDeleteGroup, groups, activeGroup, onOpenGroup, onNewTrip, email, onSignOut, onProfile, onDevTools, devReviews = 0 }: { trips: SavedTrip[]; current?: string } & Pick<Props, 'onOpen' | 'onDelete' | 'onDeleteGroup' | 'groups' | 'activeGroup' | 'onOpenGroup' | 'onNewTrip' | 'email' | 'onSignOut' | 'onProfile' | 'onDevTools' | 'devReviews'>) {
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
      <button className="trips-btn" onClick={() => setOpen(o => !o)} aria-label={`My trips${onDevTools && devReviews ? `, ${devReviews} places to review` : ''}`}><span className="trips-long">My trips</span><span className="trips-short">Trips</span> <b>{groups.length + mine.length}</b>{onDevTools && devReviews > 0 && <i className="dev-dot" aria-hidden />}</button>
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
              {g.role === 'owner' && onDeleteGroup && <button className="del" aria-label={`Delete ${g.name} for everyone`} onClick={() => { setOpen(false); onDeleteGroup(g) }}>✕</button>}
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
              {onProfile && <button onClick={() => { setOpen(false); onProfile() }}>Profile</button>}
              {onDevTools && <button onClick={() => { setOpen(false); onDevTools() }}>Dev tools{devReviews > 0 && <span className="dev-badge" aria-label={`${devReviews} to review`}>{devReviews}</span>}</button>}
              <button onClick={() => { setOpen(false); onSignOut() }}>Sign out</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function TopBar({ state, brain, trips, onOpen, onDelete, onDeleteGroup, onMoney, onPhotos, onDocs, groups, activeGroup, onOpenGroup, onNewTrip, onStartOver, onDevTools, devReviews, email, onSignOut, onProfile, me, alertsUnread = 0 }: Props) {
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
          <span className={`brain ${plansRemotely(brain) ? 'on' : ''}`} role="img"
            aria-label={plansRemotely(brain) ? `Planning with ${modelLabel(brain.model)}` : 'Offline planner'}
            title={plansRemotely(brain) ? `Planning with ${modelLabel(brain.model)}` : 'No model connected on the server: using the offline planner'} />
        )}
        <TripsMenu trips={trips} current={state.tripId} onOpen={onOpen} onDelete={onDelete} onDeleteGroup={onDeleteGroup} groups={groups} activeGroup={activeGroup} onOpenGroup={onOpenGroup} onNewTrip={onNewTrip} email={email} onSignOut={onSignOut} onProfile={onProfile} onDevTools={onDevTools} devReviews={devReviews} />
        <ToolsMenu onMoney={onMoney} onPhotos={onPhotos} onDocs={onDocs} alertsUnread={alertsUnread} />
        {onStartOver && <button className="money-btn restart-btn" onClick={onStartOver} aria-label="Start over" title="Start over: your plan so far stays in My trips"><RestartIcon /><span>Start over</span></button>}
        {onProfile && me && <button className="profile-btn" onClick={onProfile} aria-label={alertsUnread ? `Profile: ${alertsUnread} new alert${alertsUnread > 1 ? 's' : ''}` : 'Profile'} title="Profile"><Avatar id={me.id} name={me.name} size={30} />{alertsUnread > 0 && <span className="alert-dot">{alertsUnread > 9 ? '9+' : alertsUnread}</span>}</button>}
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
