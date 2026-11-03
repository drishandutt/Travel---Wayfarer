import { useMemo, useState } from 'react'
import { CATEGORIES, categoryOf } from '../../money/categories'
import { fmtMoney } from '../../money/currency'
import { budgetPace, debtsOf, effectOn, netBalances, spendOn, totalsFor, tripDay, type BudgetPace } from '../../money/engine'
import { todayLocal } from '../../money/hooks'
import { describeActivity, niceDate, timeAgo } from '../../money/util'
import type { CategoryId, Debt, Expense, Settlement } from '../../money/types'
import { ApiError } from '../../money/client'
import { Avatar, DebtRoute, Empty, Toggle, useCtx } from './parts'

// ── pieces used on more than one tab ──

export function ExpenseRow({ e }: { e: Expense }) {
  const { s, fmt, name, openExpense } = useCtx()
  const eff = effectOn(e, s.me)
  const payerIds = Object.keys(e.basePaid)
  const foreign = e.currency !== s.group.currency
  const cat = categoryOf(e.category)
  return (
    <li>
      <button className={`m-exp ${e.deletedAt ? 'deleted' : ''}`} onClick={() => openExpense(e.id)}>
        <span className="m-exp-icon" aria-hidden>{cat.emoji}</span>
        <span className="m-exp-main">
          <b>{e.title}</b>
          <small>
            {e.privateTo ? '🔒 Just for you' : payerIds.length > 1 ? `${payerIds.length} people paid` : `${name(payerIds[0])} paid`}
            {' '}{fmt(e.baseAmount)}
            {foreign && ` · ${fmtMoney(e.amount, e.currency)}`}
            {e.placeName && ` · 📍 ${e.placeName}`}
            {e.receipts.length > 0 && ' · 📷'}
            {e.pending && ' · waiting to sync'}
          </small>
        </span>
        <span className={`m-exp-effect ${e.privateTo ? '' : eff.net > 0 ? 'pos' : eff.net < 0 ? 'neg' : ''}`}>
          {e.deletedAt ? <small>deleted</small>
            : e.privateTo ? <><small>you spent</small><b>{fmt(e.baseAmount)}</b></>
            : eff.net > 0 ? <><small>you lent</small><b>{fmt(eff.net)}</b></>
            : eff.net < 0 ? <><small>you owe</small><b>{fmt(-eff.net)}</b></>
            : eff.owed > 0 ? <><small>your share</small><b>{fmt(eff.owed)}</b></>
            : <small>not you</small>}
        </span>
      </button>
    </li>
  )
}

export function BudgetMeter({ label, pace }: { label: string; pace: BudgetPace }) {
  const { fmt } = useCtx()
  const pct = Math.min(100, pace.used * 100)
  const level = pace.used >= 1 ? 'over' : pace.used >= 0.8 ? 'near' : 'ok'
  return (
    <div className={`m-meter ${level}`}>
      <div className="m-meter-head">
        <span>{label}</span>
        <b>{fmt(pace.spent)} <em>of {fmt(pace.budget)}</em></b>
      </div>
      <div className="m-meter-track" role="progressbar" aria-valuenow={Math.round(pace.used * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <small>
        {pace.left >= 0 ? `${level === 'near' ? '⚠ ' : ''}${fmt(pace.left)} left` : `▲ ${fmt(-pace.left)} over budget`}
        {pace.perDayLeft !== null && pace.left > 0 && ` · about ${fmt(pace.perDayLeft)} a day for the ${pace.daysLeft} day${pace.daysLeft === 1 ? '' : 's'} left`}
      </small>
    </div>
  )
}

// What you can do about one debt depends on which side of it you're on.
function DebtActions({ d }: { d: Debt }) {
  const { s, g, settle, toast, name } = useCtx()
  const [reminded, setReminded] = useState(false)
  const target = s.members.find(m => m.id === d.from)
  if (d.from === s.me) return <button className="cta m-small" onClick={() => settle(d)}>Settle up</button>
  const remind = async () => {
    try {
      await g.actions.call('POST', '/remind', { to: d.from, amount: d.amount })
      setReminded(true)
      toast(target?.joined ? `${name(d.from)} will see your reminder` : 'Reminder noted. They’ll see it once they join.')
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) { setReminded(true); toast(err.message) }
      else toast((err as Error).message)
    }
  }
  return (
    <>
      <button className="ghost m-small" onClick={() => settle(d)}>{d.to === s.me ? 'Mark as paid' : 'Record payment'}</button>
      {d.to === s.me && !target?.left && <button className="ghost m-small" disabled={reminded} onClick={remind}>{reminded ? 'Reminded' : 'Remind'}</button>}
    </>
  )
}

const REMIND_SHOW_MS = 3 * 86_400_000

// ── overview ──

export function OverviewTab({ onLinkTrip, linkableTrip }: { onLinkTrip: () => void; linkableTrip: string | null }) {
  const { s, fmt, name, addExpense, goTo, me } = useCtx()
  const t = useMemo(() => totalsFor(s), [s])
  const debts = useMemo(() => debtsOf(s), [s])
  const today = todayLocal()
  const mine = debts.filter(d => d.from === s.me || d.to === s.me)
  const todayMine = spendOn(s.expenses, today, 'me', s.me)
  const todayDay = tripDay(today, s.group.trip)
  const recent = s.expenses.filter(e => !e.deletedAt).slice(0, 6)
  const reminder = t.net < 0 ? s.activity.find(a => a.kind === 'remind' && a.target === s.me && Date.now() - a.createdAt < REMIND_SHOW_MS) : undefined
  const others = debts.filter(d => d.from !== s.me && d.to !== s.me)

  return (
    <div className="dash-grid">
      {reminder && <p className="m-banner span-12" role="status">{name(reminder.actor)} reminded you about {fmtMoney(reminder.detail.amount ?? 0, s.group.currency)} {timeAgo(reminder.createdAt)}.</p>}
      {linkableTrip && (
        <div className="m-banner span-12 m-banner-row">
          <span>🗺️ Connect this group to your {linkableTrip} plan, to log spending against each stop and compare it with the estimate.</span>
          <button className="ghost m-small" onClick={onLinkTrip}>Connect</button>
        </div>
      )}

      <section className="card span-7 m-hero">
        <p className="m-hero-label">{t.net > 0 ? 'You’re owed' : t.net < 0 ? 'You owe' : 'You’re all square'}</p>
        <b className={`m-hero-num ${t.net > 0 ? 'pos' : t.net < 0 ? 'neg' : ''}`}>{t.net === 0 ? '✓' : fmt(Math.abs(t.net))}</b>
        {mine.length > 0 && (
          <div className="m-debts">
            {mine.map(d => <DebtRoute key={`${d.from}-${d.to}`} debt={d} actions={<DebtActions d={d} />} />)}
          </div>
        )}
        {mine.length === 0 && others.length > 0 && <p className="m-note">You’re clear. <button className="m-link" onClick={() => goTo('balances')}>See who owes whom</button></p>}
      </section>

      <section className="card span-5 m-spend">
        <h2>Your spending{todayDay ? <em> · Day {todayDay}</em> : null}</h2>
        <div className="m-stats">
          <div><small>You’ve spent</small><b>{fmt(t.mySpend)}</b></div>
          <div><small>Today</small><b>{fmt(todayMine)}</b></div>
          <div><small>Group total</small><b>{fmt(t.groupTotal)}</b></div>
        </div>
        {me.budget ? <BudgetMeter label="Your budget" pace={budgetPace(me.budget, t.mySpend, s.group.trip, today)} /> : null}
        {s.group.budget ? <BudgetMeter label="Group budget" pace={budgetPace(s.group.budget, t.groupTotal, s.group.trip, today)} /> : null}
        {!me.budget && !s.group.budget && <button className="m-link" onClick={() => goTo('spending')}>Set a budget to see how much you have left each day</button>}
      </section>

      <section className="card span-12">
        <header className="card-head">
          <h2>Recent</h2>
          {recent.length > 0 && <button className="m-link" onClick={() => goTo('expenses')}>See all</button>}
        </header>
        {recent.length
          ? <ul className="m-exp-list">{recent.map(e => <ExpenseRow key={e.id} e={e} />)}</ul>
          : (
            <Empty icon="🧾" title="Nothing logged yet">
              Add the first expense and everyone’s balance updates straight away.
              <button className="cta m-small" onClick={() => addExpense()}>Add an expense</button>
            </Empty>
          )}
      </section>
    </div>
  )
}

// ── all expenses ──

export function ExpensesTab() {
  const { s, name, addExpense } = useCtx()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryId | ''>('')
  const [person, setPerson] = useState('')
  const q = query.trim().toLowerCase()

  const matches = (e: Expense) => {
    if (category && e.category !== category) return false
    if (person && !(person in e.basePaid) && !(person in e.baseOwed)) return false
    if (q && ![e.title, e.notes, e.placeName ?? '', categoryOf(e.category).label].some(x => x.toLowerCase().includes(q))) return false
    return true
  }
  const live = s.expenses.filter(e => !e.deletedAt && matches(e))
  const deleted = s.expenses.filter(e => e.deletedAt && matches(e))
  const dates = [...new Set(live.map(e => e.date))].sort((a, b) => b.localeCompare(a))
  const filtering = Boolean(q || category || person)
  const usedCats = CATEGORIES.filter(c => s.expenses.some(e => e.category === c.id))

  return (
    <div className="m-narrow">
      <div className="m-filters">
        <input type="search" aria-label="Search expenses" placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} />
        <select aria-label="Filter by category" value={category} onChange={e => setCategory(e.target.value as CategoryId | '')}>
          <option value="">All categories</option>
          {usedCats.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <select aria-label="Filter by person" value={person} onChange={e => setPerson(e.target.value)}>
          <option value="">Everyone</option>
          {s.members.map(m => <option key={m.id} value={m.id}>{name(m.id)}</option>)}
        </select>
      </div>

      {dates.map(date => {
        const day = tripDay(date, s.group.trip)
        return (
          <section key={date} className="m-day">
            <h3><span>{niceDate(date)}</span>{day && <em>Day {day}</em>}</h3>
            <ul className="m-exp-list">{live.filter(e => e.date === date).map(e => <ExpenseRow key={e.id} e={e} />)}</ul>
          </section>
        )
      })}

      {!live.length && (filtering
        ? <Empty icon="🔍" title="Nothing matches that" />
        : (
          <Empty icon="🧾" title="No expenses yet">
            <button className="cta m-small" onClick={() => addExpense()}>Add the first one</button>
          </Empty>
        ))}

      {deleted.length > 0 && (
        <details className="m-deleted">
          <summary>Recently deleted ({deleted.length})</summary>
          <ul className="m-exp-list">{deleted.map(e => <ExpenseRow key={e.id} e={e} />)}</ul>
        </details>
      )}
    </div>
  )
}

// ── balances ──

function BalanceBeam() {
  const { s, fmt, name } = useCtx()
  const net = useMemo(() => netBalances(s.expenses, s.settlements), [s])
  const people = s.members.filter(m => !m.left || net[m.id])
  const max = Math.max(1, ...people.map(m => Math.abs(net[m.id] ?? 0)))
  return (
    <ul className="m-beam">
      {people.map(m => {
        const n = net[m.id] ?? 0
        const w = (Math.abs(n) / max) * 100
        return (
          <li key={m.id}>
            <span className="m-beam-who"><Avatar id={m.id} name={m.name} size={26} ghost={!m.joined} /><b>{name(m.id)}</b></span>
            <span className="m-beam-bars" aria-hidden>
              <span className="neg">{n < 0 && <i style={{ width: `${w}%` }} />}</span>
              <span className="pos">{n > 0 && <i style={{ width: `${w}%` }} />}</span>
            </span>
            <span className={`m-beam-val ${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}`}>
              {n > 0 ? <>{m.id === s.me ? 'get back' : 'gets back'} <b>{fmt(n)}</b></> : n < 0 ? <>{m.id === s.me ? 'owe' : 'owes'} <b>{fmt(-n)}</b></> : 'settled'}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function PaymentRow({ p }: { p: Settlement }) {
  const { s, g, fmt, name, toast } = useCtx()
  return (
    <li className={`m-pay ${p.deletedAt ? 'deleted' : ''}`}>
      <span aria-hidden>🤝</span>
      <span className="m-exp-main">
        <b>{name(p.from)} paid {name(p.to)}</b>
        <small>{niceDate(p.date)} · {p.method}{p.note && ` · ${p.note}`}{p.currency !== s.group.currency && ` · ${fmtMoney(p.amount, p.currency)}`}{p.pending && ' · waiting to sync'}</small>
      </span>
      <b className="m-mono">{fmt(p.baseAmount)}</b>
      {!p.deletedAt && (
        <button className="m-x small" aria-label="Remove this payment" onClick={() => {
          if (!confirm(`Remove this ${fmt(p.baseAmount)} payment? The balances go back to how they were.`)) return
          g.actions.deleteSettlement(p.id)
          toast('Payment removed')
        }}>×</button>
      )}
    </li>
  )
}

export function BalancesTab() {
  const { s, g, me, settle, toast, online } = useCtx()
  const debts = useMemo(() => debtsOf(s), [s])
  const payments = s.settlements.filter(p => !p.deletedAt)
  const anything = s.expenses.some(e => !e.deletedAt && !e.privateTo) || payments.length > 0

  const setSimplify = (simplify: boolean) => {
    g.actions.call('PATCH', '', { simplify }).catch(err => toast((err as Error).message))
  }

  return (
    <div className="dash-grid">
      <section className="card span-7">
        <header className="card-head">
          <h2>{debts.length === 0 ? 'All settled' : `${debts.length} payment${debts.length > 1 ? 's' : ''} to go`}</h2>
          <button className="ghost m-small" onClick={() => settle()}>Record a payment</button>
        </header>
        <Toggle on={s.group.simplify} onChange={setSimplify} disabled={!online || me.role !== 'owner'} label="Simplify debts"
          hint={`Fewest possible payments. Nobody’s total changes, but you may pay someone you didn’t directly owe.${me.role === 'owner' ? '' : ' The admin sets this.'}`} />
        {debts.length > 0
          ? <div className="m-debts">{debts.map(d => <DebtRoute key={`${d.from}-${d.to}`} debt={d} actions={<DebtActions d={d} />} />)}</div>
          : <Empty icon="🌿" title={anything ? 'Nobody owes anybody' : 'No balances yet'}>{anything ? 'Every expense and payment evens out.' : 'They’ll show here as soon as someone adds an expense.'}</Empty>}
      </section>

      <section className="card span-5">
        <header className="card-head"><h2>Balances</h2></header>
        <BalanceBeam />
      </section>

      <section className="card span-12">
        <header className="card-head"><h2>Payments</h2></header>
        {payments.length
          ? <ul className="m-pay-list">{payments.map(p => <PaymentRow key={p.id} p={p} />)}</ul>
          : <p className="muted">Payments you record show up here.</p>}
      </section>
    </div>
  )
}

// ── activity ──

export function ActivityTab() {
  const { s, openExpense } = useCtx()
  return (
    <div className="m-narrow">
      <ul className="m-activity">
        {s.activity.map(a => {
          const { icon, text } = describeActivity(a, s)
          const expense = a.ref ? s.expenses.find(e => e.id === a.ref) : undefined
          const body = (
            <>
              <span aria-hidden>{icon}</span>
              <span className="m-activity-text">{text}<small>{timeAgo(a.createdAt)}</small></span>
            </>
          )
          return <li key={a.seq}>{expense ? <button onClick={() => openExpense(expense.id)}>{body}</button> : <div>{body}</div>}</li>
        })}
      </ul>
      {!s.activity.length && <Empty icon="🧭" title="Nothing yet" />}
    </div>
  )
}
