import { useMemo, useState } from 'react'
import { categoryOf } from '../../money/categories'
import { amountToInput, currencyDigits, parseAmount } from '../../money/currency'
import { budgetPace, plannedVsActual, spendByCategory, spendByDate, spendByMember, totalsFor, tripDay, type SpendScope } from '../../money/engine'
import { todayLocal, useRates } from '../../money/hooks'
import { download, niceDate, toCsv } from '../../money/util'
import type { PlanKey } from '../../money/types'
import { Avatar, Field, useCtx } from './parts'
import { BudgetMeter } from './tabs'

const PLAN_LABEL: Record<PlanKey, string> = { stay: 'Stay', food: 'Food & drink', entry: 'Tickets & entry', transport: 'Getting around', buffer: 'Everything else' }

export function SpendingTab() {
  const { s, g, fmt, name, me, toast, online } = useCtx()
  const [scope, setScope] = useState<SpendScope>('me')
  const t = useMemo(() => totalsFor(s), [s])
  const byCategory = useMemo(() => spendByCategory(s.expenses, scope, s.me), [s.expenses, scope, s.me])
  const byDate = useMemo(() => spendByDate(s.expenses, scope, s.me), [s.expenses, scope, s.me])
  const byMember = useMemo(() => spendByMember(s.expenses, s.members.map(m => m.id)).filter(r => r.paid || r.share), [s.expenses, s.members])
  const total = scope === 'me' ? t.mySpend : t.groupTotal
  const maxCat = Math.max(1, ...byCategory.map(c => c.amount))
  const today = todayLocal()
  const trip = s.group.trip

  // The planner's estimate is in USD, for the whole group.
  const rates = useRates(s.group.currency)
  const plan = useMemo(() => {
    const usd = rates?.rates.USD
    if (!trip || !usd) return null
    const k = 10 ** currencyDigits(s.group.currency) / usd
    const planned = Object.fromEntries(Object.entries(trip.plannedUsd).map(([key, v]) => [key, Math.round((v ?? 0) * k)])) as Partial<Record<PlanKey, number>>
    return plannedVsActual(s.expenses, planned)
  }, [trip, rates, s.expenses, s.group.currency])
  const maxPlan = Math.max(1, ...(plan ?? []).flatMap(r => [r.planned, r.actual]))
  const plannedTotal = (plan ?? []).reduce((a, r) => a + r.planned, 0)

  const [myBudget, setMyBudget] = useState(me.budget ? amountToInput(me.budget, s.group.currency) : '')
  const [groupBudget, setGroupBudget] = useState(s.group.budget ? amountToInput(s.group.budget, s.group.currency) : '')

  const saveBudgets = async () => {
    const mine = myBudget.trim() ? parseAmount(myBudget, s.group.currency) : null
    const group = groupBudget.trim() ? parseAmount(groupBudget, s.group.currency) : null
    if ((myBudget.trim() && mine === null) || (groupBudget.trim() && group === null)) { toast('Check those amounts'); return }
    try {
      if (mine !== me.budget) await g.actions.call('PATCH', `/members/${s.me}`, { budget: mine })
      if (group !== s.group.budget) await g.actions.call('PATCH', '', { budget: group })
      toast('Budget saved')
    } catch (err) {
      toast((err as Error).message)
    }
  }

  const label = (date: string) => {
    const day = tripDay(date, trip)
    return day ? `Day ${day}` : niceDate(date, { day: 'numeric', month: 'short' })
  }
  const maxDay = Math.max(1, ...byDate.map(d => d.amount))
  const peak = byDate.reduce<string | null>((best, d) => (!best || d.amount > (byDate.find(x => x.date === best)?.amount ?? 0) ? d.date : best), null)

  return (
    <div className="dash-grid">
      <div className="span-12 m-scope">
        <div className="m-segment" role="tablist" aria-label="Whose spending">
          <button role="tab" aria-selected={scope === 'me'} className={scope === 'me' ? 'on' : ''} onClick={() => setScope('me')}>Just me</button>
          <button role="tab" aria-selected={scope === 'group'} className={scope === 'group' ? 'on' : ''} onClick={() => setScope('group')}>Whole group</button>
        </div>
        <button className="ghost m-small" disabled={!s.expenses.length} onClick={() => download(`${s.group.name.replace(/[^\w-]+/g, '-').toLowerCase()}-expenses.csv`, toCsv(s), 'text/csv;charset=utf-8')}>Export spreadsheet</button>
      </div>

      <section className="card span-4 m-spend-total">
        <span className="eyebrow">{scope === 'me' ? 'Your total' : 'Group total'}</span>
        <b className="m-hero-num">{fmt(total)}</b>
        {scope === 'me'
          ? <small>Your share of group costs {fmt(t.myShare)}{t.myPrivate ? ` + ${fmt(t.myPrivate)} just for you` : ''}</small>
          : <small>{s.expenses.filter(e => !e.deletedAt && !e.privateTo).length} shared expenses</small>}
      </section>

      <section className="card span-8">
        <header className="card-head"><h2>Budget</h2></header>
        <div className="m-budget-grid">
          <div className="m-meters">
            {me.budget ? <BudgetMeter label="Your budget" pace={budgetPace(me.budget, t.mySpend, trip, today)} /> : <p className="muted">No personal budget yet.</p>}
            {s.group.budget ? <BudgetMeter label="Group budget" pace={budgetPace(s.group.budget, t.groupTotal, trip, today)} /> : <p className="muted">No group budget yet.</p>}
          </div>
          <form className="m-budget-form" onSubmit={e => { e.preventDefault(); saveBudgets() }}>
            <Field label={`Your budget (${s.group.currency})`} hint="Only you can see this"><input inputMode="decimal" value={myBudget} onChange={e => setMyBudget(e.target.value)} placeholder="None" /></Field>
            {me.role === 'owner' && <Field label={`Group budget (${s.group.currency})`} hint="Everyone can see this"><input inputMode="decimal" value={groupBudget} onChange={e => setGroupBudget(e.target.value)} placeholder="None" /></Field>}
            <button className="ghost m-small" disabled={!online}>Save</button>
          </form>
        </div>
      </section>

      <section className="card span-6">
        <header className="card-head"><h2>By category</h2></header>
        {byCategory.length ? (
          <ul className="m-bars">
            {byCategory.map(c => {
              const cat = categoryOf(c.category)
              return (
                <li key={c.category}>
                  <span className="m-bars-label"><span aria-hidden>{cat.emoji}</span> {cat.label}</span>
                  <span className="m-bars-track"><i style={{ width: `${(c.amount / maxCat) * 100}%` }} /></span>
                  <span className="m-bars-val"><b>{fmt(c.amount)}</b><em>{Math.round((c.amount / Math.max(1, total)) * 100)}%</em></span>
                </li>
              )
            })}
          </ul>
        ) : <p className="muted">Nothing spent yet.</p>}
      </section>

      <section className="card span-6">
        <header className="card-head"><h2>By day</h2></header>
        {byDate.length === 1 ? (
          <p className="m-one-day"><b>{fmt(byDate[0].amount)}</b> on {niceDate(byDate[0].date)}</p>
        ) : byDate.length ? (
          <>
            <div className="m-cols" role="img" aria-label={`Spending per day, highest ${peak ? fmt(byDate.find(d => d.date === peak)!.amount) : ''}`}>
              {byDate.map(d => (
                <div key={d.date} className={`m-col ${d.date === today ? 'today' : ''}`} tabIndex={0} aria-label={`${niceDate(d.date)}: ${fmt(d.amount)}`}>
                  <span className="m-col-tip"><b>{fmt(d.amount)}</b> {niceDate(d.date)}</span>
                  <span className="m-col-bar">
                    {d.date === peak && <em>{fmt(d.amount)}</em>}
                    <i style={{ height: `${Math.max(2, (d.amount / maxDay) * 100)}%` }} />
                  </span>
                  <small>{label(d.date)}</small>
                </div>
              ))}
            </div>
            <details className="m-table-view">
              <summary>See as a table</summary>
              <table>
                <tbody>{byDate.map(d => <tr key={d.date}><th scope="row">{niceDate(d.date)}{tripDay(d.date, trip) ? ` · Day ${tripDay(d.date, trip)}` : ''}</th><td>{fmt(d.amount)}</td></tr>)}</tbody>
              </table>
            </details>
          </>
        ) : <p className="muted">Nothing spent yet.</p>}
      </section>

      {trip && (
        <section className="card span-7">
          <header className="card-head">
            <h2>Planned vs actual</h2>
            {plan && plannedTotal > 0 && <small>{fmt(t.groupTotal)} of ~{fmt(plannedTotal)} · Excludes flights</small>}
          </header>
          {plan ? (
            <>
              <div className="m-legend" aria-hidden><span><i className="bar" />Spent</span><span><i className="tick" />Planned</span></div>
              <ul className="m-bullets">
                {plan.map(r => (
                  <li key={r.key}>
                    <span className="m-bars-label">{PLAN_LABEL[r.key]}</span>
                    <span className="m-bullet-track">
                      <i className={r.actual > r.planned ? 'over' : ''} style={{ width: `${(r.actual / maxPlan) * 100}%` }} />
                      {r.planned > 0 && <u style={{ left: `${(r.planned / maxPlan) * 100}%` }} />}
                    </span>
                    <span className="m-bars-val">
                      <b>{fmt(r.actual)}</b>
                      <em>{r.actual > r.planned && r.planned > 0 ? `▲ ${fmt(r.actual - r.planned)} over` : `of ${fmt(r.planned)}`}</em>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : <p className="muted">Needs an exchange rate. Appears once you’re online.</p>}
        </section>
      )}

      <section className={`card ${trip ? 'span-5' : 'span-12'}`}>
        <header className="card-head"><h2>Paid vs share</h2></header>
        {byMember.length ? (
          <table className="m-people-table">
            <thead><tr><th scope="col">Person</th><th scope="col">Paid</th><th scope="col">Share</th></tr></thead>
            <tbody>
              {byMember.map(r => {
                const m = s.members.find(x => x.id === r.memberId)
                return (
                  <tr key={r.memberId}>
                    <th scope="row"><Avatar id={r.memberId} name={m?.name ?? '?'} size={24} ghost={!m?.joined} />{name(r.memberId)}</th>
                    <td>{fmt(r.paid)}</td>
                    <td>{fmt(r.share)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : <p className="muted">Nothing shared yet.</p>}
      </section>
    </div>
  )
}
