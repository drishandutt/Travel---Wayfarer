import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, NetworkError, api, readLocal, writeLocal } from '../../money/client'
import { CURRENCIES, fmtMoney, homeCurrency, parseAmount } from '../../money/currency'
import { claimLocal, drainClosedGroups, useGroup, useGroups, type AccountHandle, type Rates } from '../../money/hooks'
import { describeOp } from '../../money/outbox'
import { describeActivity } from '../../money/util'
import { Memphis } from '../Memphis'
import type { Account, Debt, GroupState, InvitePreview, TripSummary } from '../../money/types'
import { ExpenseDetail } from './ExpenseDetail'
import { ExpenseForm, type ExpensePrefill } from './ExpenseForm'
import { AccountCard, PeopleTab } from './PeopleTab'
import { SettleForm } from './SettleForm'
import { SpendingTab } from './SpendingTab'
import { ActivityTab, BalancesTab, ExpensesTab, OverviewTab } from './tabs'
import { AccountCtx, Avatar, Ctx, Empty, Field, buildCtxHelpers, useEscape, type Tab } from './parts'

export interface MoneyTrip {
  summary: TripSummary | null
  linkedGroupId?: string
  link: (groupId: string | undefined) => void
}

const errorText = (err: unknown) => (err instanceof NetworkError ? 'You seem to be offline. Try again when you’re connected.' : (err as Error).message)

// ── signing in ────────────────────────────────────────────────────────────────

export function AuthScreen({ inviteName, onDone }: { inviteName?: string; onDone: (a: Account) => void }) {
  // Your email is your account. The server says if it needs anything more: a name for a
  // new address, or the password on an account that has added one.
  const [step, setStep] = useState<'email' | 'name' | 'password'>('email')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const out = await api<{ user?: Account; next?: 'name' | 'password' }>('POST', '/auth/email', {
        email: email.trim(),
        ...(step === 'name' ? { name: name.trim() } : {}),
        ...(step === 'password' ? { password } : {}),
      })
      if (out.user) onDone(out.user)
      else if (out.next) setStep(out.next)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const back = () => {
    setStep('email')
    setPassword('')
    setError('')
  }

  return (
    <div className="m-center">
      <form className="card m-auth" onSubmit={e => { e.preventDefault(); submit() }}>
        <Memphis layout="card" />
        {inviteName && <span className="eyebrow">You’re invited</span>}
        <h1>
          {step === 'name' ? 'Nice to meet you'
            : step === 'password' ? 'Welcome back'
            : inviteName ? <>Join <em>{inviteName}</em></>
            : <>Plan together. <em>Split it fairly.</em></>}
        </h1>

        {step === 'email' && (
          <Field label="Email" hint="Nothing to confirm. Use it on any device.">
            <input type="email" autoFocus required value={email} maxLength={200} onChange={e => setEmail(e.target.value)} autoComplete="email" inputMode="email" placeholder="you@example.com" />
          </Field>
        )}
        {step === 'name' && (
          <Field label="What should your group call you?">
            <input autoFocus required value={name} maxLength={60} onChange={e => setName(e.target.value)} autoComplete="given-name" placeholder="Your name" />
          </Field>
        )}
        {step === 'password' && (
          <Field label={`Password for ${email.trim()}`}>
            <input type="password" autoFocus required value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
        )}

        {error && <p className="m-note bad" role="alert">{error}</p>}
        <button className="cta" disabled={busy}>{busy ? 'One moment…' : step === 'email' ? 'Continue' : step === 'name' ? 'Get started' : 'Sign in'}</button>
        {step !== 'email' && <p className="m-note">Not {email.trim()}? <button type="button" className="m-link" onClick={back}>Use a different email</button></p>}
      </form>
    </div>
  )
}

// ── following an invite link ──────────────────────────────────────────────────

export function useInvite(token: string | null, userId?: string) {
  const [invite, setInvite] = useState<InvitePreview | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setInvite(null)
    setError('')
    if (!token) return
    api<InvitePreview>('GET', `/invite/${encodeURIComponent(token)}`).then(setInvite).catch(err => setError(errorText(err)))
  }, [token, userId])
  return { invite, error }
}

export function JoinScreen({ token, invite, account, onJoined, onCancel }: { token: string; invite: InvitePreview; account: Account; onJoined: (groupId: string) => void; onCancel: () => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const open = invite.members.filter(m => m.claimable)
  const everyone = invite.members.map(m => m.name)

  useEffect(() => { if (invite.alreadyMember) onJoined(invite.groupId) }, [invite, onJoined])

  const join = async (claim?: string) => {
    setBusy(true)
    setError('')
    try {
      const { groupId } = await api<{ groupId: string }>('POST', `/invite/${encodeURIComponent(token)}/join`, { claim: claim ?? null })
      onJoined(groupId)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="m-center">
      <div className="card m-auth">
        <Memphis layout="card" />
        <span className="eyebrow">You’re invited{invite.city ? ` · ${invite.city}` : ''}</span>
        <h1>Join <em>{invite.groupName}</em></h1>
        <p className="m-lede">{everyone.length ? `${everyone.slice(0, 4).join(', ')}${everyone.length > 4 ? ` and ${everyone.length - 4} more` : ''} ${everyone.length > 1 ? 'are' : 'is'} in. ` : ''}Balances are kept in {invite.currency}.</p>
        {open.length > 0 && <h4>Is one of these you?</h4>}
        <div className="m-claims">
          {open.map(m => (
            <button key={m.id} className="m-claim" disabled={busy} onClick={() => join(m.id)}>
              <Avatar id={m.id} name={m.name} ghost />I’m {m.name}
            </button>
          ))}
          <button className={open.length ? 'ghost' : 'cta'} disabled={busy} onClick={() => join()}>
            {open.length ? `I’m not listed: join as ${account.name}` : `Join as ${account.name}`}
          </button>
        </div>
        {error && <p className="m-note bad" role="alert">{error}</p>}
        <button className="m-link" onClick={onCancel}>Not now</button>
      </div>
    </div>
  )
}

// ── the list of groups ────────────────────────────────────────────────────────

function GroupList({ trip, prefillLabel, onOpen, onClose }: { trip: MoneyTrip; prefillLabel?: string; onOpen: (id: string) => void; onClose: () => void }) {
  const { groups, refresh } = useGroups(true)
  const [creating, setCreating] = useState(false)
  const summary = trip.summary
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState(homeCurrency)
  const [people, setPeople] = useState('')
  const [useTrip, setUseTrip] = useState(Boolean(summary))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEscape(onClose)

  useEffect(() => { if (summary && useTrip && !name) setName(summary.name) }, [summary, useTrip, name])

  const create = async () => {
    setBusy(true)
    setError('')
    try {
      const members = people.split(',').map(x => x.trim()).filter(Boolean)
      const tripData = useTrip ? summary : null
      // a budget from the planner comes across in the group's currency, if a rate is to hand
      let budget: number | null = null
      if (tripData?.budgetUsd) {
        const rates = await api<Rates>('GET', `/fx?base=${currency}`).catch(() => null)
        if (rates?.rates.USD) budget = parseAmount(String(Math.round(tripData.budgetUsd / rates.rates.USD)), currency)
      }
      const state = await api<GroupState>('POST', '/groups', { name: name.trim(), currency, members, trip: tripData, budget })
      if (tripData) trip.link(state.group.id)
      refresh().catch(() => {})
      onOpen(state.group.id)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const showForm = creating || groups?.length === 0

  return (
    <div className="m-narrow m-list">
      {prefillLabel && <p className="m-banner">Pick a group to log “{prefillLabel}” in, or start one.</p>}
      <header className="m-list-head">
        <Memphis layout="corner" />
        <h1>Groups</h1>
      </header>

      {groups === null && <div className="m-skeleton" />}
      {groups && groups.length > 0 && (
        <ul className="m-groups">
          {groups.map(g => (
            <li key={g.id}>
              <button onClick={() => onOpen(g.id)}>
                <span className="m-group-main">
                  <b>{g.name}</b>
                  <small>{g.memberCount} {g.memberCount === 1 ? 'person' : 'people'}{g.id === trip.linkedGroupId ? ' · This trip' : ''}</small>
                </span>
                <span className={`m-group-bal ${g.myNet > 0 ? 'pos' : g.myNet < 0 ? 'neg' : ''}`}>
                  {g.myNet > 0 ? <><small>you’re owed</small><b>{fmtMoney(g.myNet, g.currency)}</b></>
                    : g.myNet < 0 ? <><small>you owe</small><b>{fmtMoney(-g.myNet, g.currency)}</b></>
                    : <small>settled</small>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!showForm && <button className="cta" onClick={() => setCreating(true)}>Start a new group</button>}

      {showForm && (
        <form className="card m-new-group" onSubmit={e => { e.preventDefault(); create() }}>
          <h2>New group</h2>
          {summary && (
            <button type="button" role="switch" aria-checked={useTrip} className={`m-toggle ${useTrip ? 'on' : ''}`} onClick={() => { setUseTrip(!useTrip); if (useTrip && name === summary.name) setName('') }}>
              <i />
              <span><b>Link to your {summary.city} plan</b><small>Compare spending with the estimate.</small></span>
            </button>
          )}
          <div className="m-two">
            <Field label="Group name"><input required value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="Goa with the crew" /></Field>
            <Field label="Currency" hint="Expenses can be in any currency.">
              <select value={currency} onChange={e => setCurrency(e.target.value)}>
                {[...new Set([currency, ...CURRENCIES])].map(c => <option key={c}>{c}</option>)}
              </select>
            </Field>
          </div>
          <Field label="People (optional)" hint="Emails or names, comma-separated."><input value={people} onChange={e => setPeople(e.target.value)} placeholder="priya@example.com, Sam" autoComplete="off" /></Field>
          {error && <p className="m-note bad" role="alert">{error}</p>}
          <div className="m-form-actions">
            {groups && groups.length > 0 && <button type="button" className="ghost" onClick={() => setCreating(false)}>Cancel</button>}
            <button className="cta" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create group'}</button>
          </div>
        </form>
      )}

      {groups && groups.length > 0 && <AccountCard className="m-account-card" />}
    </div>
  )
}

// ── inside a group ────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'expenses', label: 'Expenses' },
  { id: 'balances', label: 'Balances' },
  { id: 'spending', label: 'Spending' },
  { id: 'activity', label: 'Activity' },
  { id: 'people', label: 'People' },
]

type Overlay =
  | { kind: 'new'; prefill?: ExpensePrefill }
  | { kind: 'edit'; id: string }
  | { kind: 'view'; id: string }
  | { kind: 'settle'; debt?: Debt }
  | null

function GroupView({ groupId, trip, prefill, onBack, onClose, onSessionEnded }: { groupId: string; trip: MoneyTrip; prefill?: ExpensePrefill; onBack: () => void; onClose: () => void; onSessionEnded: () => void }) {
  const g = useGroup(groupId)
  const { state: s, status, live, waiting, failed, incoming, clearIncoming, actions } = g
  const [tab, setTab] = useState<Tab>('overview')
  const [overlay, setOverlay] = useState<Overlay>(prefill ? { kind: 'new', prefill } : null)
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([])
  const toastSeq = useRef(0)
  useEscape(onClose)

  const toast = useCallback((text: string) => {
    const id = ++toastSeq.current
    setToasts(t => [...t.slice(-2), { id, text }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4500)
  }, [])

  // Other people's changes surface as they happen.
  useEffect(() => {
    if (!incoming.length || !s) return
    incoming.forEach(a => toast(describeActivity(a, s).text))
    clearIncoming()
  }, [incoming, s, toast, clearIncoming])

  // A trip connected to a group this person isn't in: drop the connection and show their own groups.
  useEffect(() => {
    if (status !== 'gone' || trip.linkedGroupId !== groupId) return
    trip.link(undefined)
    onBack()
  }, [status])
  // signed out somewhere else: back to the sign-in screen, not "you're not in this group"
  useEffect(() => { if (status === 'signed-out') onSessionEnded() }, [status, onSessionEnded])

  const ctx = useMemo(() => {
    if (!s) return null
    const me = s.members.find(m => m.id === s.me)
    if (!me) return null
    const fresh = live !== 'offline'
    return {
      s, g, me, online: fresh, toast,
      ...buildCtxHelpers(s),
      addExpense: (p?: ExpensePrefill) => setOverlay({ kind: 'new', prefill: p }),
      openExpense: (id: string) => setOverlay({ kind: 'view', id }),
      editExpense: (id: string) => setOverlay({ kind: 'edit', id }),
      settle: (debt?: Debt) => setOverlay({ kind: 'settle', debt }),
      goTo: setTab,
    }
  }, [s, g, live, toast])

  if (status === 'gone') {
    return (
      <div className="m-center">
        <Empty icon="🧭" title="You’re not in this group any more">
          It may have been deleted, or you may have been removed from it.
          <button className="ghost" onClick={onBack}>Back to your groups</button>
        </Empty>
      </div>
    )
  }
  if (!ctx || !s) return <div className="m-narrow m-loading"><button className="dash-back m-close" onClick={onClose}>← Map</button><div className="m-skeleton" /></div>

  const liveLabel = live === 'live' ? 'Live' : live === 'offline' ? 'Offline' : 'Reconnecting'
  const linkable = ctx.me.role === 'owner' && trip.summary && trip.linkedGroupId !== groupId && !s.group.trip ? trip.summary.city : null
  const editing = overlay?.kind === 'edit' ? s.expenses.find(e => e.id === overlay.id) : undefined

  return (
    <Ctx.Provider value={ctx}>
      <div className="m-group-bar">
        <button className="dash-back m-close" onClick={onClose}>← Map</button>
        <button className="m-back" onClick={onBack} aria-label="All groups">Groups</button>
        <h1>{s.group.name}</h1>
        <span className={`m-live ${live}`} role="status" title={live === 'live' ? 'Changes from your group appear as they happen' : 'Your changes are saved here and will sync'}><i />{liveLabel}{waiting > 0 && ` · ${waiting} to sync`}</span>
        <button className={`cta m-add ${tab === 'people' ? 'quiet' : ''}`} onClick={() => setOverlay({ kind: 'new' })}><span aria-hidden>+</span> Add expense</button>
      </div>
      <nav className="m-tabs" aria-label="Group sections">
        {TABS.map(t => <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </nav>

      {failed.map(op => (
        <div className="m-banner bad m-banner-row m-narrow-banner" key={op.opId} role="alert">
          <span><b>{describeOp(op)}</b> didn’t go through: {op.error}</span>
          <button className="ghost m-small" onClick={() => actions.dismissOp(op.opId)}>Dismiss</button>
        </div>
      ))}

      <div className="m-page" key={tab}>
        {tab === 'overview' && <OverviewTab linkableTrip={linkable} onLinkTrip={() => trip.link(groupId)} />}
        {tab === 'expenses' && <ExpensesTab />}
        {tab === 'balances' && <BalancesTab />}
        {tab === 'spending' && <SpendingTab />}
        {tab === 'activity' && <ActivityTab />}
        {tab === 'people' && <PeopleTab onLeft={onBack} />}
      </div>

      {overlay?.kind === 'new' && <ExpenseForm prefill={overlay.prefill} onClose={() => setOverlay(null)} />}
      {overlay?.kind === 'edit' && editing && <ExpenseForm key={editing.id} existing={editing} onClose={() => setOverlay(null)} />}
      {overlay?.kind === 'view' && <ExpenseDetail id={overlay.id} onClose={() => setOverlay(null)} />}
      {overlay?.kind === 'settle' && <SettleForm debt={overlay.debt} onClose={() => setOverlay(null)} />}

      <div className="m-toasts" aria-live="polite">
        {toasts.map(t => <div key={t.id} className="m-toast">{t.text}</div>)}
      </div>
    </Ctx.Provider>
  )
}

// ── the whole money screen ────────────────────────────────────────────────────

export function MoneyApp({ acct, trip, prefill, onClose }: { acct: AccountHandle; trip: MoneyTrip; prefill?: ExpensePrefill; onClose: () => void }) {
  const { account, status, signedIn, signOut, retry } = acct
  const [groupId, setGroupIdState] = useState<string | null>(() => trip.linkedGroupId ?? readLocal<string | null>('lastGroup', null))
  const [pendingPrefill, setPendingPrefill] = useState(prefill)

  const setGroupId = useCallback((id: string | null) => {
    writeLocal('lastGroup', id)
    setGroupIdState(id)
  }, [])

  const accountCtx = useMemo(() => (account ? { account, signedIn, signOut: async () => { await signOut(); setGroupIdState(null) } } : null), [account, signedIn, signOut])

  let body
  if (status === 'loading' && !account) {
    body = <div className="m-narrow"><div className="m-skeleton" /></div>
  } else if (status === 'unavailable') {
    body = (
      <div className="m-center">
        <Empty icon="🗄️" title="Money tracking isn’t switched on here yet">
          This server has nowhere safe to keep shared balances, so it’s turned off rather than risk losing them.
        </Empty>
      </div>
    )
  } else if (!account && status === 'offline') {
    body = (
      <div className="m-center">
        <Empty icon="📡" title="Can’t reach the server">
          Signing in needs a connection. Once you’ve signed in once, you can log expenses offline.
          <button className="ghost" onClick={retry}>Try again</button>
        </Empty>
      </div>
    )
  } else if (!account) {
    body = <AuthScreen onDone={signedIn} />
  } else if (groupId) {
    body = <GroupView key={groupId} groupId={groupId} trip={trip} prefill={pendingPrefill} onBack={() => { setPendingPrefill(undefined); setGroupId(null) }} onClose={onClose} onSessionEnded={retry} />
  } else {
    body = <GroupList trip={trip} prefillLabel={pendingPrefill?.title} onOpen={setGroupId} onClose={onClose} />
  }

  return (
    <div className="dash m-app" role="dialog" aria-label="Money">
      {!(account && groupId) && (
        <div className="m-top">
          <button className="dash-back" onClick={onClose}>← Back to map</button>
        </div>
      )}
      {accountCtx ? <AccountCtx.Provider value={accountCtx}>{body}</AccountCtx.Provider> : body}
    </div>
  )
}

// A short balance for the top bar, without opening anything.
export function useMoneyBadge(open: boolean) {
  const [badge, setBadge] = useState<{ net: number; currency: string } | null>(null)
  const load = useCallback(() => {
    api<{ user: Account | null }>('GET', '/auth/me').then(async ({ user }) => {
      if (!user) { setBadge(null); return }
      claimLocal(user)
      await drainClosedGroups()
      return api<{ groups: { myNet: number; currency: string }[] }>('GET', '/groups').then(({ groups }) => {
        const owing = groups.filter(g => g.myNet !== 0)
        setBadge(owing.length === 1 ? { net: owing[0].myNet, currency: owing[0].currency } : null)
      })
    }).catch((err: unknown) => { if (!(err instanceof NetworkError || err instanceof ApiError)) throw err })
  }, [])
  useEffect(() => { if (!open) load() }, [open, load])
  useEffect(() => {
    window.addEventListener('online', load)
    return () => window.removeEventListener('online', load)
  }, [load])
  return badge
}
