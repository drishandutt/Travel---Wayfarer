import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyOps, dropSent, enqueue, nextToSend, type Op } from '../../src/money/outbox'
import type { ExpenseInput, GroupState } from '../../src/money/types'

// The offline queue is what stands between patchy signal and lost or doubled expenses.

const input = (over: Partial<ExpenseInput> = {}): ExpenseInput => ({
  id: 'e1', title: 'Dinner', amount: 1000, currency: 'USD', fxRate: 1, category: 'food', date: '2026-11-10', notes: '', private: false,
  payers: [{ memberId: 'a', amount: 1000 }], split: { method: 'equal', entries: [{ memberId: 'a', value: 1 }, { memberId: 'b', value: 1 }] }, ...over,
})
const create = (over: Partial<Op> = {}, inp = input()): Op => ({ opId: 'c', kind: 'expense.create', input: inp, ...over } as Op)
const update = (opId: string, inp: ExpenseInput, baseRev: number): Op => ({ opId, kind: 'expense.update', input: inp, baseRev })
const remove = (opId = 'd'): Op => ({ opId, kind: 'expense.delete', id: 'e1', title: 'Dinner' })

const state: GroupState = {
  group: { id: 'g', name: 'G', currency: 'USD', simplify: true, budget: null, inviteToken: 't', trip: null, version: 1, createdAt: 0 },
  me: 'a', members: [], expenses: [], settlements: [], comments: [], activity: [],
}

describe('queueing changes', () => {
  it('an edit to something not sent yet folds into the create', () => {
    const q = enqueue([create()], update('u', input({ title: 'Edited' }), 1))
    assert.equal(q.length, 1)
    assert.equal(q[0].kind, 'expense.create')
    assert.equal((q[0] as { input: ExpenseInput }).input.title, 'Edited')
  })
  it('an edit to something possibly already on the server stays separate, or it would be lost', () => {
    const q = enqueue([create({ attempted: true })], update('u', input({ title: 'Edited' }), 1))
    assert.deepEqual(q.map(o => o.kind), ['expense.create', 'expense.update'])
    assert.equal((q[1] as { baseRev: number }).baseRev, 1)
    assert.equal((q[0] as { input: ExpenseInput }).input.title, 'Dinner', 'what was sent stays what was sent')
  })
  it('deleting something never sent just forgets it', () => {
    assert.deepEqual(enqueue([create()], remove()), [])
  })
  it('deleting something possibly on the server sends the delete after it', () => {
    assert.deepEqual(enqueue([create({ attempted: true })], remove()).map(o => o.kind), ['expense.create', 'expense.delete'])
  })
  it('deleting keeps edits already on their way, in order', () => {
    const q = enqueue(enqueue([create({ attempted: true })], update('u', input({ title: 'x' }), 1)), remove())
    assert.deepEqual(q.map(o => o.kind), ['expense.create', 'expense.update', 'expense.delete'])
  })
  it('a payment works the same way', () => {
    const pay = { id: 'p1', from: 'a', to: 'b', amount: 5, currency: 'USD', fxRate: 1, date: '2026-11-10', note: '', method: 'cash' as const }
    const unsent: Op = { opId: 'p', kind: 'settlement.create', input: pay }
    assert.deepEqual(enqueue([unsent], { opId: 'x', kind: 'settlement.delete', id: 'p1' }), [])
    assert.deepEqual(enqueue([{ ...unsent, attempted: true }], { opId: 'x', kind: 'settlement.delete', id: 'p1' }).map(o => o.kind), ['settlement.create', 'settlement.delete'])
  })
  it('two edits offline become one, so the second isn’t refused as a conflict', () => {
    const q = enqueue([update('u1', input({ title: 'First' }), 4)], update('u2', input({ title: 'Second' }), 4))
    assert.equal(q.length, 1)
    assert.equal((q[0] as { baseRev: number }).baseRev, 4)
    assert.equal((q[0] as { input: ExpenseInput }).input.title, 'Second')
  })
  it('an edit after one already on its way counts on that one landing', () => {
    const q = enqueue([{ ...update('u1', input({ title: 'First' }), 4), attempted: true }], update('u2', input({ title: 'Second' }), 4))
    assert.deepEqual(q.map(o => (o as { baseRev: number }).baseRev), [4, 5])
  })
  it('never folds into a change the server already refused', () => {
    const q = enqueue([create({ error: 'nope' })], update('u', input({ title: 'Edited' }), 1))
    assert.equal(q.length, 2)
  })
})

describe('what gets sent next', () => {
  it('goes in order, skipping what’s refused or already through', () => {
    const q = [create({ opId: '1', error: 'no' }), create({ opId: '2', sent: true }), create({ opId: '3' }), create({ opId: '4' })]
    assert.equal(nextToSend(q)?.opId, '3')
    assert.equal(nextToSend([create({ sent: true })]), undefined)
  })
})

describe('what the screen shows', () => {
  it('an expense sent but not yet re-fetched stays on screen, no longer marked waiting', () => {
    const shown = applyOps(state, [create({ attempted: true, sent: true })])
    assert.equal(shown.expenses.length, 1)
    assert.equal(shown.expenses[0].pending, false)
    assert.equal(applyOps(state, [create()]).expenses[0].pending, true)
  })
  it('once re-fetched, what was sent is dropped and what wasn’t is kept', () => {
    const q = dropSent([create({ opId: '1', sent: true }), create({ opId: '2' })])
    assert.deepEqual(q.map(o => o.opId), ['2'])
  })
  it('a refused change isn’t shown as if it happened', () => {
    assert.equal(applyOps(state, [create({ error: 'nope' })]).expenses.length, 0)
  })
  it('doesn’t add an expense twice once the server has it too', () => {
    const withIt = applyOps(state, [create({ sent: true })])
    assert.equal(applyOps(withIt, [create({ sent: true })]).expenses.length, 1)
  })
})
