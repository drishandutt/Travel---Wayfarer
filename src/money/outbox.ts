import { computeExpense, convert } from './engine'
import type { Comment, Expense, ExpenseInput, GroupState, Settlement, SettlementInput } from './types'

// Signal on a trip is patchy, so a change is written here first and sent when it can be.
// Until the server confirms it, the same engine the server uses works out its effect on
// the balances, so the screen is right straight away. Ops carry client-made ids, which
// makes sending one twice harmless.
//
// An op moves through: queued -> attempted (a request went out, so it may have landed even
// if no reply came back) -> sent (confirmed, kept on screen until a fresh copy of the group
// arrives) or error (the server refused it, and the person gets told).

export type Op = { opId: string; attempted?: boolean; sent?: boolean; error?: string } & (
  | { kind: 'expense.create'; input: ExpenseInput }
  | { kind: 'expense.update'; input: ExpenseInput; baseRev: number }
  | { kind: 'expense.delete'; id: string; title: string }
  | { kind: 'expense.restore'; id: string; title: string }
  | { kind: 'settlement.create'; input: SettlementInput }
  | { kind: 'settlement.delete'; id: string }
  | { kind: 'comment.create'; id: string; expenseId: string; body: string; createdAt: number }
)

export function requestFor(op: Op, groupId: string): [method: string, path: string, body?: unknown] {
  const g = `/groups/${groupId}`
  switch (op.kind) {
    case 'expense.create': return ['POST', `${g}/expenses`, { ...op.input, opId: op.opId }]
    case 'expense.update': return ['PUT', `${g}/expenses/${op.input.id}`, { ...op.input, baseRev: op.baseRev, opId: op.opId }]
    case 'expense.delete': return ['DELETE', `${g}/expenses/${op.id}`]
    case 'expense.restore': return ['POST', `${g}/expenses/${op.id}/restore`, {}]
    case 'settlement.create': return ['POST', `${g}/settlements`, op.input]
    case 'settlement.delete': return ['DELETE', `${g}/settlements/${op.id}`]
    case 'comment.create': return ['POST', `${g}/expenses/${op.expenseId}/comments`, { id: op.id, body: op.body }]
  }
}

export function describeOp(op: Op): string {
  switch (op.kind) {
    case 'expense.create': return `Adding “${op.input.title}”`
    case 'expense.update': return `Your edit to “${op.input.title}”`
    case 'expense.delete': return `Deleting “${op.title}”`
    case 'expense.restore': return `Restoring “${op.title}”`
    case 'settlement.create': return 'Recording a payment'
    case 'settlement.delete': return 'Removing a payment'
    case 'comment.create': return 'Your comment'
  }
}

export const nextToSend = (ops: Op[]) => ops.find(o => !o.error && !o.sent)
export const dropSent = (ops: Op[]) => ops.filter(o => !o.sent)

function pendingExpense(input: ExpenseInput, state: GroupState, pending: boolean, base?: Expense): Expense {
  const { private: isPrivate, ...rest } = input
  const c = computeExpense(input, state.group.currency)
  return {
    ...rest, ...c, groupId: state.group.id, rev: base?.rev ?? 0, privateTo: base?.privateTo ?? (isPrivate ? state.me : null),
    createdBy: base?.createdBy ?? state.me, createdAt: base?.createdAt ?? Date.now(), updatedBy: state.me, updatedAt: Date.now(),
    deletedAt: null, deletedBy: null, receipts: base?.receipts ?? [], pending,
  }
}

// The state as this device sees it: the server's, plus whatever hasn't reached it yet.
// An op the server refused is left out, and shown to the person instead.
export function applyOps(server: GroupState, ops: Op[]): GroupState {
  if (!ops.length) return server
  let expenses = server.expenses
  let settlements = server.settlements
  let comments = server.comments
  for (const op of ops) {
    if (op.error) continue
    const pending = !op.sent
    try {
      switch (op.kind) {
        case 'expense.create':
          if (!expenses.some(e => e.id === op.input.id)) expenses = [pendingExpense(op.input, server, pending), ...expenses]
          break
        case 'expense.update':
          expenses = expenses.map(e => (e.id === op.input.id ? pendingExpense(op.input, server, pending, e) : e))
          break
        case 'expense.delete':
          expenses = expenses.map(e => (e.id === op.id ? { ...e, deletedAt: Date.now(), deletedBy: server.me, pending } : e))
          break
        case 'expense.restore':
          expenses = expenses.map(e => (e.id === op.id ? { ...e, deletedAt: null, deletedBy: null, pending } : e))
          break
        case 'settlement.create':
          if (!settlements.some(s => s.id === op.input.id)) {
            const s: Settlement = {
              ...op.input, groupId: server.group.id, baseAmount: convert(op.input.amount, op.input.currency, op.input.fxRate, server.group.currency),
              createdBy: server.me, createdAt: Date.now(), deletedAt: null, pending,
            }
            settlements = [s, ...settlements]
          }
          break
        case 'settlement.delete':
          settlements = settlements.map(s => (s.id === op.id ? { ...s, deletedAt: Date.now(), pending } : s))
          break
        case 'comment.create':
          if (!comments.some(c => c.id === op.id)) {
            const c: Comment = { id: op.id, expenseId: op.expenseId, memberId: server.me, body: op.body, createdAt: op.createdAt, pending }
            comments = [...comments, c]
          }
          break
      }
    } catch {
      // a queued entry the engine can't work out will be refused by the server too, and shown then
    }
  }
  return { ...server, expenses, settlements, comments }
}

// Adding to the queue. A later change folds into an earlier one only if that one has never
// been sent. Once a request has gone out it may be on the server even with no reply, so
// folding into it would lose the change: it goes in the queue behind it instead.
export function enqueue(ops: Op[], op: Op): Op[] {
  const unsent = (o: Op) => !o.error && !o.sent && !o.attempted
  const at = (test: (o: Op) => boolean) => ops.findIndex(test)

  if (op.kind === 'expense.update') {
    const id = op.input.id
    const create = at(o => o.kind === 'expense.create' && o.input.id === id && unsent(o))
    if (create >= 0) return ops.map((o, i) => (i === create ? { ...o, input: op.input } as Op : o))
    const update = at(o => o.kind === 'expense.update' && o.input.id === id && unsent(o))
    if (update >= 0) return ops.map((o, i) => (i === update ? { ...o, input: op.input } as Op : o))
    // whatever is already on its way moves the revision on by the time this one lands
    const ahead = ops.filter(o => !o.error && (
      (o.kind === 'expense.update' && o.input.id === id) || ((o.kind === 'expense.delete' || o.kind === 'expense.restore') && o.id === id)
    )).length
    return [...ops, { ...op, baseRev: op.baseRev + ahead }]
  }
  if (op.kind === 'expense.delete') {
    const create = at(o => o.kind === 'expense.create' && o.input.id === op.id && unsent(o))
    if (create >= 0) return ops.filter((_, i) => i !== create)
  }
  if (op.kind === 'settlement.delete') {
    const create = at(o => o.kind === 'settlement.create' && o.input.id === op.id && unsent(o))
    if (create >= 0) return ops.filter((_, i) => i !== create)
  }
  return [...ops, op]
}
