import { currencyDigits } from './currency'
import { categoryOf } from './categories'
import type { CategoryId, Debt, Expense, ExpenseInput, GroupState, MoneyMap, Payer, PlanKey, Settlement, SplitInput, TripSummary } from './types'

// The money maths. Pure and integer-only, and shared by the browser (live previews,
// offline entries) and the server (the source of truth), so they can't disagree.
// Two rules hold everywhere: an expense's shares add up to exactly its amount, and
// everyone's balances in a group add up to exactly zero.

// The most one expense or payment can be, in minor units. With the per-group limits on how
// many there can be, totals stay well inside what a double holds exactly.
export const MAX_AMOUNT = 5e11

export class SplitError extends Error {
  // `delta` is how far off the entry is, in the method's own unit: positive = still to assign.
  constructor(public code: string, message: string, public delta?: number) { super(message) }
}

// FNV-1a. Decides who gets a leftover cent: stable for one expense, different between expenses.
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

// Splits `total` in proportion to integer `weights` so the parts add up to exactly `total`
// (largest remainder). Ties go by hash, so the extra cent doesn't always land on the same person.
export function allocate(total: number, weights: number[], keys: string[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0) throw new SplitError('no-weight', 'Nobody to split between')
  const T = BigInt(Math.abs(total))
  const S = BigInt(sum)
  const parts = weights.map(w => (T * BigInt(w)) / S)
  const rems = weights.map(w => (T * BigInt(w)) % S)
  let left = Number(T - parts.reduce((a, b) => a + b, 0n))
  const order = weights.map((_, i) => i).filter(i => weights[i] > 0).sort((a, b) => {
    if (rems[a] !== rems[b]) return rems[a] > rems[b] ? -1 : 1
    return hash(keys[a]) - hash(keys[b]) || a - b
  })
  for (const i of order) {
    if (left <= 0) break
    parts[i] += 1n
    left--
  }
  const sign = total < 0 ? -1 : 1
  return parts.map(p => Number(p) * sign || 0)
}

const toMap = (ids: string[], values: number[]): MoneyMap => {
  const out: MoneyMap = {}
  ids.forEach((id, i) => { if (values[i] !== 0) out[id] = (out[id] ?? 0) + values[i] })
  return out
}
const sumOf = (m: MoneyMap) => Object.values(m).reduce((a, b) => a + b, 0)

// Who owes what for an expense, by each of Splitwise's methods. Throws SplitError
// with a usable message when the entry doesn't add up.
export function computeShares(total: number, split: SplitInput, seed: string): MoneyMap {
  if (!Number.isSafeInteger(total) || total <= 0) throw new SplitError('bad-total', 'Enter an amount first')
  const entries = split.entries
  const ids = entries.map(e => e.memberId)
  if (new Set(ids).size !== ids.length) throw new SplitError('duplicate', 'Someone is listed twice')
  const keys = ids.map(id => `${seed}:${id}`)

  switch (split.method) {
    case 'equal': {
      if (!ids.length) throw new SplitError('nobody', 'Pick at least one person')
      return toMap(ids, allocate(total, ids.map(() => 1), keys))
    }
    case 'exact': {
      if (entries.some(e => !Number.isSafeInteger(e.value) || e.value < 0)) throw new SplitError('negative', 'Amounts can’t be negative')
      const delta = total - entries.reduce((a, e) => a + e.value, 0)
      if (delta !== 0) throw new SplitError('exact-mismatch', 'The amounts don’t add up to the total', delta)
      return toMap(ids, entries.map(e => e.value))
    }
    case 'percent': {
      if (entries.some(e => !Number.isSafeInteger(e.value) || e.value < 0)) throw new SplitError('negative', 'Percentages can’t be negative')
      const delta = 10000 - entries.reduce((a, e) => a + e.value, 0)
      if (delta !== 0) throw new SplitError('percent-mismatch', 'Percentages must add up to 100%', delta)
      return toMap(ids, allocate(total, entries.map(e => e.value), keys))
    }
    case 'shares': {
      if (entries.some(e => !Number.isSafeInteger(e.value) || e.value < 0)) throw new SplitError('negative', 'Shares can’t be negative')
      if (!entries.some(e => e.value > 0)) throw new SplitError('no-shares', 'Give someone at least one share')
      return toMap(ids, allocate(total, entries.map(e => e.value), keys))
    }
    case 'adjust': {
      // what's left after the adjustments is split equally, then each adjustment goes on top
      if (!ids.length) throw new SplitError('nobody', 'Pick at least one person')
      if (entries.some(e => !Number.isSafeInteger(e.value))) throw new SplitError('bad-value', 'Check the adjustments')
      const rest = total - entries.reduce((a, e) => a + e.value, 0)
      const base = allocate(rest, ids.map(() => 1), keys)
      const shares = base.map((b, i) => b + entries[i].value)
      if (shares.some(s => s < 0)) throw new SplitError('adjust-negative', 'Those adjustments leave someone owing less than nothing')
      return toMap(ids, shares)
    }
    case 'itemized':
      return itemizedShares(total, split, seed)
    default:
      throw new SplitError('bad-method', 'Unknown split method')
  }
}

// Each line is split between the people who had it. Whatever the lines don't cover
// (tax, tip, service, or a discount) is shared in proportion to what each person had.
function itemizedShares(total: number, split: SplitInput, seed: string): MoneyMap {
  const items = split.items ?? []
  if (!items.length) throw new SplitError('no-items', 'Add at least one item')
  const subtotal: MoneyMap = {}
  let itemsTotal = 0
  for (const item of items) {
    if (!Number.isSafeInteger(item.amount) || item.amount <= 0) throw new SplitError('bad-item', `Enter a price for ${item.name || 'each item'}`)
    if (!item.memberIds.length) throw new SplitError('item-nobody', `Pick who had ${item.name || 'each item'}`)
    if (new Set(item.memberIds).size !== item.memberIds.length) throw new SplitError('duplicate', 'Someone is listed twice')
    itemsTotal += item.amount
    const parts = allocate(item.amount, item.memberIds.map(() => 1), item.memberIds.map(id => `${seed}:${item.id}:${id}`))
    item.memberIds.forEach((id, i) => { subtotal[id] = (subtotal[id] ?? 0) + parts[i] })
  }
  const extras = total - itemsTotal
  const ids = Object.keys(subtotal)
  if (extras === 0) return toMap(ids, ids.map(id => subtotal[id]))
  const parts = allocate(extras, ids.map(id => subtotal[id]), ids.map(id => `${seed}:extras:${id}`))
  const shares = ids.map((id, i) => subtotal[id] + parts[i])
  if (shares.some(s => s < 0)) throw new SplitError('item-negative', 'The items add up to more than the total', extras)
  return toMap(ids, shares)
}

export function payersProblem(total: number, payers: Payer[]): { message: string; delta?: number } | null {
  if (!payers.length) return { message: 'Pick who paid' }
  if (new Set(payers.map(p => p.memberId)).size !== payers.length) return { message: 'Someone is listed twice' }
  if (payers.some(p => !Number.isSafeInteger(p.amount) || p.amount <= 0)) return { message: 'Each payer needs an amount' }
  const delta = total - payers.reduce((a, p) => a + p.amount, 0)
  return delta === 0 ? null : { message: 'What people paid must add up to the total', delta }
}

// Minor units of one currency to minor units of another, at a locked rate.
export function convert(amount: number, from: string, rate: number, to: string): number {
  if (from === to) return amount
  return Math.round(amount * rate * 10 ** (currencyDigits(to) - currencyDigits(from)))
}

export interface ComputedExpense { shares: MoneyMap; baseAmount: number; basePaid: MoneyMap; baseOwed: MoneyMap }

// Everything derived from an expense entry. The group currency amounts are allocated,
// not converted one by one, so they still add up exactly after rounding.
export function computeExpense(e: Pick<ExpenseInput, 'id' | 'amount' | 'currency' | 'fxRate' | 'payers' | 'split'>, groupCurrency: string): ComputedExpense {
  const shares = computeShares(e.amount, e.split, e.id)
  const problem = payersProblem(e.amount, e.payers)
  if (problem) throw new SplitError('payers', problem.message, problem.delta)
  const baseAmount = convert(e.amount, e.currency, e.fxRate, groupCurrency)
  if (baseAmount <= 0) throw new SplitError('bad-rate', 'That exchange rate makes this worth nothing in the group currency')
  if (!Number.isSafeInteger(baseAmount) || baseAmount > MAX_AMOUNT) throw new SplitError('too-large', 'That amount is too large')
  const paidIds = e.payers.map(p => p.memberId)
  const owedIds = Object.keys(shares)
  // the same tie-break for both, so paying and owing the same part nets to exactly zero
  const tieBreak = (id: string) => `${e.id}:${id}`
  return {
    shares,
    baseAmount,
    basePaid: toMap(paidIds, allocate(baseAmount, e.payers.map(p => p.amount), paidIds.map(tieBreak))),
    baseOwed: toMap(owedIds, allocate(baseAmount, owedIds.map(id => shares[id]), owedIds.map(tieBreak))),
  }
}

// ── balances ──────────────────────────────────────────────────────────────────

const activeGroupExpenses = (expenses: Expense[]) => expenses.filter(e => !e.deletedAt && !e.privateTo)
const activeSettlements = (settlements: Settlement[]) => settlements.filter(s => !s.deletedAt)

// Positive = the group owes this person. Always sums to zero.
export function netBalances(expenses: Expense[], settlements: Settlement[]): MoneyMap {
  const net: MoneyMap = {}
  const add = (id: string, n: number) => { net[id] = (net[id] ?? 0) + n }
  for (const e of activeGroupExpenses(expenses)) {
    for (const [id, n] of Object.entries(e.basePaid)) add(id, n)
    for (const [id, n] of Object.entries(e.baseOwed)) add(id, -n)
  }
  for (const s of activeSettlements(settlements)) {
    add(s.from, s.baseAmount)
    add(s.to, -s.baseAmount)
  }
  return net
}

// Who owes whom if nothing is simplified. Each person who underpaid on an expense owes
// the people who overpaid, in proportion. Working through debtors against what's still
// outstanding (rather than each one independently) keeps the rounding exact, so these
// debts always reproduce netBalances to the cent.
export function pairwiseDebts(expenses: Expense[], settlements: Settlement[]): Debt[] {
  const ledger = new Map<string, number>()
  const owe = (from: string, to: string, n: number) => {
    const [a, b, signed] = from < to ? [from, to, n] : [to, from, -n]
    const key = `${a}|${b}`
    ledger.set(key, (ledger.get(key) ?? 0) + signed)
  }
  for (const e of activeGroupExpenses(expenses)) {
    const net: MoneyMap = {}
    for (const [id, n] of Object.entries(e.basePaid)) net[id] = (net[id] ?? 0) + n
    for (const [id, n] of Object.entries(e.baseOwed)) net[id] = (net[id] ?? 0) - n
    const creditors = Object.keys(net).filter(id => net[id] > 0).sort()
    const debtors = Object.keys(net).filter(id => net[id] < 0).sort()
    const remaining = creditors.map(id => net[id])
    for (const d of debtors) {
      const parts = allocate(-net[d], remaining, creditors.map(c => `${e.id}:${d}:${c}`))
      parts.forEach((n, i) => {
        if (!n) return
        owe(d, creditors[i], n)
        remaining[i] -= n
      })
    }
  }
  for (const s of activeSettlements(settlements)) owe(s.to, s.from, s.baseAmount)
  const out: Debt[] = []
  for (const [key, n] of ledger) {
    if (n === 0) continue
    const [a, b] = key.split('|')
    out.push(n > 0 ? { from: a, to: b, amount: n } : { from: b, to: a, amount: -n })
  }
  return out.sort((x, y) => y.amount - x.amount)
}

// The fewest payments that clear everyone's balance. People whose balances cancel out
// among themselves can settle separately, so the minimum is one payment fewer than the
// number of people, per such cluster: find the most clusters, then settle each greedily.
// Finding clusters is exponential, so very large groups fall back to one greedy pass.
const EXACT_LIMIT = 14

export function simplifyDebts(net: MoneyMap): Debt[] {
  const ids = Object.keys(net).filter(id => net[id] !== 0).sort()
  const clusters = ids.length <= EXACT_LIMIT ? zeroSumClusters(ids, net) : [ids]
  return clusters.flatMap(c => settleCluster(c, net)).sort((a, b) => b.amount - a.amount)
}

function zeroSumClusters(ids: string[], net: MoneyMap): string[][] {
  if (!ids.length) return []
  const size = 1 << ids.length
  const sums = new Array<number>(size).fill(0)
  const best = new Int8Array(size)
  for (let mask = 1; mask < size; mask++) {
    const low = 31 - Math.clz32(mask & -mask)
    sums[mask] = sums[mask & (mask - 1)] + net[ids[low]]
    let top = 0
    for (let i = 0; i < ids.length; i++) if (mask & (1 << i)) top = Math.max(top, best[mask ^ (1 << i)])
    best[mask] = top + (sums[mask] === 0 ? 1 : 0)
  }
  const clusters: string[][] = []
  let current: string[] = []
  let mask = size - 1
  while (mask) {
    let pick = -1
    for (let i = 0; i < ids.length; i++) {
      if (!(mask & (1 << i))) continue
      if (pick < 0 || best[mask ^ (1 << i)] > best[mask ^ (1 << pick)]) pick = i
    }
    current.push(ids[pick])
    mask ^= 1 << pick
    if (sums[mask] === 0) { clusters.push(current); current = [] }
  }
  return clusters
}

function settleCluster(ids: string[], net: MoneyMap): Debt[] {
  const left = new Map(ids.map(id => [id, net[id]]))
  const out: Debt[] = []
  for (;;) {
    const open = [...left.entries()].filter(([, n]) => n !== 0)
    if (!open.length) return out
    const debtor = open.reduce((a, b) => (b[1] < a[1] ? b : a))
    const creditor = open.reduce((a, b) => (b[1] > a[1] ? b : a))
    // balances always sum to zero; if they somehow don't, stop rather than loop forever
    if (debtor[1] >= 0 || creditor[1] <= 0) return out
    const amount = Math.min(-debtor[1], creditor[1])
    out.push({ from: debtor[0], to: creditor[0], amount })
    left.set(debtor[0], debtor[1] + amount)
    left.set(creditor[0], creditor[1] - amount)
  }
}

export function debtsOf(s: Pick<GroupState, 'group' | 'expenses' | 'settlements'>): Debt[] {
  return s.group.simplify ? simplifyDebts(netBalances(s.expenses, s.settlements)) : pairwiseDebts(s.expenses, s.settlements)
}

// ── spending ──────────────────────────────────────────────────────────────────

export interface Totals {
  groupTotal: number            // everything the group has spent together
  myShare: number               // my part of group expenses
  myPaid: number                // what I actually paid for the group
  myPrivate: number             // my just-for-me expenses
  mySpend: number               // my share + my private: what the trip is costing me
  net: number
}

export function totalsFor(s: Pick<GroupState, 'me' | 'expenses' | 'settlements'>): Totals {
  const group = activeGroupExpenses(s.expenses)
  const myShare = group.reduce((a, e) => a + (e.baseOwed[s.me] ?? 0), 0)
  const myPrivate = s.expenses.filter(e => !e.deletedAt && e.privateTo === s.me).reduce((a, e) => a + e.baseAmount, 0)
  return {
    groupTotal: group.reduce((a, e) => a + e.baseAmount, 0),
    myShare,
    myPaid: group.reduce((a, e) => a + (e.basePaid[s.me] ?? 0), 0),
    myPrivate,
    mySpend: myShare + myPrivate,
    net: netBalances(s.expenses, s.settlements)[s.me] ?? 0,
  }
}

// What an expense means for one person: positive = they lent, negative = they borrowed.
export function effectOn(e: Expense, memberId: string): { paid: number; owed: number; net: number } {
  const paid = e.basePaid[memberId] ?? 0
  const owed = e.baseOwed[memberId] ?? 0
  return { paid, owed, net: paid - owed }
}

export type SpendScope = 'group' | 'me'

// The amount an expense counts for: the whole bill for the group, my part of it for me.
const counted = (e: Expense, scope: SpendScope, me: string) => {
  if (e.deletedAt) return 0
  if (scope === 'group') return e.privateTo ? 0 : e.baseAmount
  return e.privateTo ? (e.privateTo === me ? e.baseAmount : 0) : (e.baseOwed[me] ?? 0)
}

export function spendByCategory(expenses: Expense[], scope: SpendScope, me: string): { category: CategoryId; amount: number }[] {
  const byCat = new Map<CategoryId, number>()
  for (const e of expenses) {
    const n = counted(e, scope, me)
    if (n) byCat.set(e.category, (byCat.get(e.category) ?? 0) + n)
  }
  return [...byCat].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount)
}

export function spendByDate(expenses: Expense[], scope: SpendScope, me: string): { date: string; amount: number }[] {
  const byDate = new Map<string, number>()
  for (const e of expenses) {
    const n = counted(e, scope, me)
    if (n) byDate.set(e.date, (byDate.get(e.date) ?? 0) + n)
  }
  return [...byDate].map(([date, amount]) => ({ date, amount })).sort((a, b) => a.date.localeCompare(b.date))
}

export const spendOn = (expenses: Expense[], date: string, scope: SpendScope, me: string) =>
  expenses.filter(e => e.date === date).reduce((a, e) => a + counted(e, scope, me), 0)

export function spendByMember(expenses: Expense[], memberIds: string[]): { memberId: string; paid: number; share: number }[] {
  const group = activeGroupExpenses(expenses)
  return memberIds.map(memberId => ({
    memberId,
    paid: group.reduce((a, e) => a + (e.basePaid[memberId] ?? 0), 0),
    share: group.reduce((a, e) => a + (e.baseOwed[memberId] ?? 0), 0),
  }))
}

// Actual spend against the planner's estimate, one row per line of the estimate.
export function plannedVsActual(expenses: Expense[], planned: Partial<Record<PlanKey, number>>): { key: PlanKey; planned: number; actual: number }[] {
  const actual: Partial<Record<PlanKey, number>> = {}
  for (const e of activeGroupExpenses(expenses)) {
    const key = categoryOf(e.category).plan
    if (key) actual[key] = (actual[key] ?? 0) + e.baseAmount
  }
  return (['stay', 'food', 'entry', 'transport', 'buffer'] as PlanKey[])
    .filter(key => planned[key] !== undefined || actual[key] !== undefined)
    .map(key => ({ key, planned: planned[key] ?? 0, actual: actual[key] ?? 0 }))
}

// ── trip days & budget pace ───────────────────────────────────────────────────

const DAY = 86_400_000
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`).getTime()

// Which day of the trip a date falls on, if it's during the trip.
export function tripDay(date: string, trip: TripSummary | null): number | null {
  if (!trip?.startDate) return null
  const n = Math.round((utc(date) - utc(trip.startDate)) / DAY) + 1
  return n >= 1 && n <= trip.days ? n : null
}

export interface BudgetPace {
  budget: number
  spent: number
  left: number
  used: number                  // 0..1+
  daysLeft: number | null       // trip days still to come, today included
  perDayLeft: number | null     // what you can spend per remaining day
}

export function budgetPace(budget: number, spent: number, trip: TripSummary | null, today: string): BudgetPace {
  const left = budget - spent
  let daysLeft: number | null = null
  if (trip?.startDate) {
    const end = utc(trip.startDate) + (trip.days - 1) * DAY
    const from = Math.max(utc(today), utc(trip.startDate))
    daysLeft = Math.max(0, Math.round((end - from) / DAY) + 1)
  }
  return {
    budget,
    spent,
    left,
    used: budget > 0 ? spent / budget : 0,
    daysLeft,
    perDayLeft: daysLeft ? Math.floor(Math.max(0, left) / daysLeft) : null,
  }
}

export { sumOf }
