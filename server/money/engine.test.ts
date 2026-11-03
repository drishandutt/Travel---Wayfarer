import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { allocate, budgetPace, computeExpense, computeShares, convert, netBalances, pairwiseDebts, plannedVsActual, simplifyDebts, spendByCategory, sumOf, totalsFor, tripDay, SplitError } from '../../src/money/engine'
import { amountToInput, parseAmount, parseHundredths, parseSigned } from '../../src/money/currency'
import { guessCategory } from '../../src/money/categories'
import type { Expense, ExpenseInput, MoneyMap, Settlement, SplitInput } from '../../src/money/types'

const equal = (...ids: string[]): SplitInput => ({ method: 'equal', entries: ids.map(memberId => ({ memberId, value: 1 })) })
const by = (method: SplitInput['method'], values: Record<string, number>): SplitInput => ({ method, entries: Object.entries(values).map(([memberId, value]) => ({ memberId, value })) })

function expense(id: string, amount: number, payers: Record<string, number>, split: SplitInput, over: Partial<ExpenseInput & Expense> = {}): Expense {
  const input = {
    id, amount, currency: 'USD', fxRate: 1,
    payers: Object.entries(payers).map(([memberId, n]) => ({ memberId, amount: n })),
    split, ...over,
  }
  const c = computeExpense(input, 'USD')
  return { title: id, category: 'other', date: '2026-11-01', notes: '', groupId: 'g', rev: 1, privateTo: null, createdBy: 'a', createdAt: 0, updatedBy: null, updatedAt: 0, deletedAt: null, deletedBy: null, receipts: [], ...input, ...c, ...over } as Expense
}

const settlement = (from: string, to: string, baseAmount: number, over: Partial<Settlement> = {}): Settlement => ({
  id: `${from}-${to}`, from, to, amount: baseAmount, currency: 'USD', fxRate: 1, date: '2026-11-01', note: '', method: 'cash', groupId: 'g', baseAmount, createdBy: from, createdAt: 0, deletedAt: null, ...over,
})

// A small seeded random generator, so failures reproduce.
function rng(seed: number) {
  return (n: number) => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return Math.floor((seed / 4294967296) * n)
  }
}

describe('allocate', () => {
  it('always adds up to the total', () => {
    const r = rng(1)
    for (let t = 0; t < 500; t++) {
      const n = 1 + r(12)
      const weights = Array.from({ length: n }, () => r(5000))
      if (!weights.some(Boolean)) continue
      const total = r(10_000_000)
      const parts = allocate(total, weights, weights.map((_, i) => `k${i}`))
      assert.equal(parts.reduce((a, b) => a + b, 0), total)
      parts.forEach((p, i) => assert.ok(p >= 0 && (weights[i] > 0 || p === 0)))
    }
  })
  it('handles amounts too big for doubles to multiply', () => {
    const parts = allocate(9_000_000_000_000, [3333, 3333, 3334], ['a', 'b', 'c'])
    assert.equal(parts.reduce((a, b) => a + b, 0), 9_000_000_000_000)
    assert.equal(parts[2], 3_000_600_000_000)
  })
  it('hands a leftover cent to different people across expenses', () => {
    const lucky = new Set<number>()
    for (let i = 0; i < 40; i++) {
      const parts = allocate(100, [1, 1, 1], ['a', 'b', 'c'].map(id => `exp${i}:${id}`))
      lucky.add(parts.indexOf(34))
    }
    assert.equal(lucky.size, 3)
  })
  it('gives the same answer every time for the same expense', () => {
    const keys = ['x:a', 'x:b', 'x:c']
    assert.deepEqual(allocate(100, [1, 1, 1], keys), allocate(100, [1, 1, 1], keys))
  })
})

describe('split methods', () => {
  it('equal: 100 between 3 is 33 + 33 + 34', () => {
    const s = computeShares(100, equal('a', 'b', 'c'), 'seed')
    assert.equal(sumOf(s), 100)
    assert.deepEqual(Object.values(s).sort(), [33, 33, 34])
  })
  it('equal: leaves out anyone not included', () => {
    assert.deepEqual(computeShares(1000, equal('a', 'b'), 'seed'), { a: 500, b: 500 })
  })
  it('exact: must add up to the total', () => {
    assert.deepEqual(computeShares(1000, by('exact', { a: 700, b: 300 }), 's'), { a: 700, b: 300 })
    assert.throws(() => computeShares(1000, by('exact', { a: 700, b: 200 }), 's'), (e: SplitError) => e.code === 'exact-mismatch' && e.delta === 100)
    assert.throws(() => computeShares(1000, by('exact', { a: 1200, b: -200 }), 's'), (e: SplitError) => e.code === 'negative')
  })
  it('percent: must add up to 100 and rounds exactly', () => {
    assert.deepEqual(computeShares(1000, by('percent', { a: 7500, b: 2500 }), 's'), { a: 750, b: 250 })
    const s = computeShares(1000, by('percent', { a: 3333, b: 3333, c: 3334 }), 's')
    assert.equal(sumOf(s), 1000)
    assert.throws(() => computeShares(1000, by('percent', { a: 5000, b: 4000 }), 's'), (e: SplitError) => e.code === 'percent-mismatch' && e.delta === 1000)
  })
  it('shares: splits by weight, including fractions', () => {
    assert.deepEqual(computeShares(4000, by('shares', { a: 200, b: 100, c: 100 }), 's'), { a: 2000, b: 1000, c: 1000 })
    assert.deepEqual(computeShares(2500, by('shares', { a: 150, b: 100 }), 's'), { a: 1500, b: 1000 })
    assert.deepEqual(computeShares(1000, by('shares', { a: 100, b: 0 }), 's'), { a: 1000 })
    assert.throws(() => computeShares(1000, by('shares', { a: 0, b: 0 }), 's'), (e: SplitError) => e.code === 'no-shares')
  })
  it('adjust: equal split of the rest, then adjustments on top', () => {
    assert.deepEqual(computeShares(10000, by('adjust', { a: 1000, b: 0, c: 0 }), 's'), { a: 4000, b: 3000, c: 3000 })
    assert.deepEqual(computeShares(10000, by('adjust', { a: -1000, b: 0 }), 's'), { a: 4500, b: 5500 })
    assert.throws(() => computeShares(100, by('adjust', { a: 500, b: 0 }), 's'), (e: SplitError) => e.code === 'adjust-negative')
  })
  it('itemized: tax and tip follow what each person had', () => {
    const split: SplitInput = {
      method: 'itemized',
      entries: [],
      items: [
        { id: 'i1', name: 'Steak', amount: 6000, memberIds: ['a'] },
        { id: 'i2', name: 'Salad', amount: 2000, memberIds: ['b'] },
        { id: 'i3', name: 'Wine', amount: 2000, memberIds: ['a', 'b'] },
      ],
    }
    // a had 7000, b had 3000; the 2000 of tax and tip goes 70/30
    assert.deepEqual(computeShares(12000, split, 's'), { a: 8400, b: 3600 })
  })
  it('itemized: a discount comes off in proportion, and items can’t be empty', () => {
    const items = [{ id: 'i1', name: 'A', amount: 3000, memberIds: ['a'] }, { id: 'i2', name: 'B', amount: 1000, memberIds: ['b'] }]
    assert.deepEqual(computeShares(2000, { method: 'itemized', entries: [], items }, 's'), { a: 1500, b: 500 })
    assert.throws(() => computeShares(1000, { method: 'itemized', entries: [], items: [] }, 's'), (e: SplitError) => e.code === 'no-items')
    assert.throws(() => computeShares(1000, { method: 'itemized', entries: [], items: [{ id: 'x', name: 'A', amount: 1000, memberIds: [] }] }, 's'), (e: SplitError) => e.code === 'item-nobody')
  })
  it('rejects a duplicate person and a zero total', () => {
    assert.throws(() => computeShares(100, { method: 'equal', entries: [{ memberId: 'a', value: 1 }, { memberId: 'a', value: 1 }] }, 's'), (e: SplitError) => e.code === 'duplicate')
    assert.throws(() => computeShares(0, equal('a'), 's'), (e: SplitError) => e.code === 'bad-total')
  })
})

describe('foreign currency', () => {
  it('converts across different numbers of decimals', () => {
    assert.equal(convert(3000, 'JPY', 0.55, 'INR'), 165000) // ¥3,000 at 0.55 = ₹1,650.00
    assert.equal(convert(165000, 'INR', 1.8181, 'JPY'), 3000)
    assert.equal(convert(1000, 'USD', 1, 'USD'), 1000)
  })
  it('group currency amounts still add up after rounding', () => {
    const c = computeExpense({ id: 'x', amount: 1001, currency: 'JPY', fxRate: 0.6037, payers: [{ memberId: 'a', amount: 1001 }], split: equal('a', 'b', 'c') }, 'INR')
    assert.equal(sumOf(c.baseOwed), c.baseAmount)
    assert.equal(sumOf(c.basePaid), c.baseAmount)
    assert.equal(sumOf(c.shares), 1001)
  })
  it('rejects a payer total that doesn’t match', () => {
    assert.throws(() => computeExpense({ id: 'x', amount: 1000, currency: 'USD', fxRate: 1, payers: [{ memberId: 'a', amount: 900 }], split: equal('a') }, 'USD'), (e: SplitError) => e.code === 'payers')
  })
})

describe('balances', () => {
  it('a pays for three: the others each owe a third', () => {
    const net = netBalances([expense('e', 3000, { a: 3000 }, equal('a', 'b', 'c'))], [])
    assert.deepEqual(net, { a: 2000, b: -1000, c: -1000 })
  })
  it('several payers on one expense', () => {
    const net = netBalances([expense('e', 3000, { a: 2000, b: 1000 }, equal('a', 'b', 'c'))], [])
    assert.deepEqual(net, { a: 1000, b: 0, c: -1000 })
  })
  it('settling up clears it, and a partial payment partly clears it', () => {
    const e = expense('e', 2000, { a: 2000 }, equal('a', 'b'))
    assert.deepEqual(netBalances([e], [settlement('b', 'a', 1000)]), { a: 0, b: 0 })
    assert.deepEqual(netBalances([e], [settlement('b', 'a', 400)]), { a: 600, b: -600 })
  })
  it('ignores deleted expenses, deleted payments and private expenses', () => {
    const e = expense('e', 2000, { a: 2000 }, equal('a', 'b'), { deletedAt: 1 })
    const p = expense('p', 900, { a: 900 }, equal('a'), { privateTo: 'a' })
    assert.deepEqual(netBalances([e, p], [settlement('b', 'a', 500, { deletedAt: 1 })]), {})
  })
})

describe('debts', () => {
  it('simplify removes the middle person', () => {
    // a owes b 10, b owes c 10: a can just pay c
    const debts = simplifyDebts({ a: -1000, b: 0, c: 1000 })
    assert.deepEqual(debts, [{ from: 'a', to: 'c', amount: 1000 }])
  })
  it('finds people who cancel out, beating a greedy pass', () => {
    // Always matching the biggest debtor to the biggest creditor takes 4 payments here.
    // d and e cancel out, as do a, b and c, so 3 is enough.
    assert.equal(simplifyDebts({ a: 500, b: -200, c: -300, d: 400, e: -400 }).length, 3)
    assert.equal(simplifyDebts({ a: -500, b: 500, c: -300, d: 300 }).length, 2)
  })
  it('without simplifying, keeps who actually owes whom', () => {
    const e1 = expense('e1', 2000, { b: 2000 }, equal('a', 'b'))
    const e2 = expense('e2', 2000, { c: 2000 }, equal('b', 'c'))
    const debts = pairwiseDebts([e1, e2], [])
    assert.deepEqual(new Set(debts.map(d => `${d.from}>${d.to}:${d.amount}`)), new Set(['a>b:1000', 'b>c:1000']))
  })
  it('pays down one direction before reversing it', () => {
    const e = expense('e', 2000, { a: 2000 }, equal('a', 'b'))
    assert.deepEqual(pairwiseDebts([e], [settlement('b', 'a', 1500)]), [{ from: 'a', to: 'b', amount: 500 }])
  })
  it('zero balances mean no payments at all', () => {
    assert.deepEqual(simplifyDebts({ a: 0, b: 0 }), [])
    assert.deepEqual(simplifyDebts({}), [])
  })

  const replay = (debts: { from: string; to: string; amount: number }[]) => {
    const out: MoneyMap = {}
    for (const d of debts) {
      out[d.from] = (out[d.from] ?? 0) - d.amount
      out[d.to] = (out[d.to] ?? 0) + d.amount
    }
    return out
  }
  const nonZero = (m: MoneyMap) => Object.fromEntries(Object.entries(m).filter(([, n]) => n !== 0))

  it('on random trips, every number agrees to the cent', () => {
    const r = rng(42)
    const people = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    for (let trip = 0; trip < 200; trip++) {
      const group = people.slice(0, 2 + r(6))
      const expenses: Expense[] = []
      const settlements: Settlement[] = []
      for (let i = 0; i < 1 + r(15); i++) {
        const amount = 1 + r(500000)
        const pick = () => group[r(group.length)]
        const who = group.filter(() => r(3) > 0)
        const inSplit = who.length ? who : [pick()]
        const payer = pick()
        const fxRate = r(2) ? 1 : 0.5 + r(1000) / 100
        const currency = fxRate === 1 ? 'USD' : 'JPY'
        const split: SplitInput = r(2)
          ? equal(...inSplit)
          : { method: 'shares', entries: inSplit.map(memberId => ({ memberId, value: 1 + r(400) })) }
        expenses.push(expense(`t${trip}e${i}`, amount, { [payer]: amount }, split, { currency, fxRate }))
      }
      for (let i = 0; i < r(4); i++) {
        const [from, to] = [group[r(group.length)], group[r(group.length)]]
        if (from !== to) settlements.push(settlement(from, to, 1 + r(100000), { id: `s${i}` }))
      }

      for (const e of expenses) {
        assert.equal(sumOf(e.baseOwed), e.baseAmount)
        assert.equal(sumOf(e.basePaid), e.baseAmount)
        assert.equal(sumOf(e.shares), e.amount)
      }
      const net = netBalances(expenses, settlements)
      assert.equal(sumOf(net), 0, 'balances sum to zero')
      const simplified = simplifyDebts(net)
      assert.deepEqual(nonZero(replay(simplified)), nonZero(net), 'simplified debts reproduce balances')
      assert.ok(simplified.length <= Math.max(0, Object.values(net).filter(Boolean).length - 1), 'at most n-1 payments')
      assert.deepEqual(nonZero(replay(pairwiseDebts(expenses, settlements))), nonZero(net), 'pairwise debts reproduce balances')
    }
  })
  it('a very large group still settles in at most n-1 payments', () => {
    const net: MoneyMap = {}
    let total = 0
    for (let i = 0; i < 39; i++) { net[`m${i}`] = (i % 2 ? 1 : -1) * (100 + i * 7); total += net[`m${i}`] }
    net.last = -total
    const debts = simplifyDebts(net)
    assert.ok(debts.length <= 39)
    assert.deepEqual(nonZero(replay(debts)), nonZero(net))
  })
})

describe('spending', () => {
  const trip = { name: 'Tokyo', city: 'Tokyo', country: 'Japan', startDate: '2026-11-10', days: 5, travelers: 3, localCurrency: 'JPY', plannedUsd: {}, budgetUsd: null, stops: [] }
  it('counts my share plus my private spending as what I spent', () => {
    const expenses = [
      expense('dinner', 3000, { a: 3000 }, equal('a', 'b', 'c'), { category: 'food' }),
      expense('souvenir', 500, { a: 500 }, equal('a'), { privateTo: 'a', category: 'shopping' }),
      expense('theirs', 700, { b: 700 }, equal('b'), { privateTo: 'b', category: 'shopping' }),
    ]
    const t = totalsFor({ me: 'a', expenses, settlements: [] })
    assert.deepEqual(t, { groupTotal: 3000, myShare: 1000, myPaid: 3000, myPrivate: 500, mySpend: 1500, net: 2000 })
    assert.deepEqual(spendByCategory(expenses, 'me', 'a'), [{ category: 'food', amount: 1000 }, { category: 'shopping', amount: 500 }])
    assert.deepEqual(spendByCategory(expenses, 'group', 'a'), [{ category: 'food', amount: 3000 }])
  })
  it('compares actual spend with the plan', () => {
    const expenses = [expense('h', 5000, { a: 5000 }, equal('a'), { category: 'stay' }), expense('f', 100, { a: 100 }, equal('a'), { category: 'flights' })]
    assert.deepEqual(plannedVsActual(expenses, { stay: 4000, food: 300 }), [{ key: 'stay', planned: 4000, actual: 5000 }, { key: 'food', planned: 300, actual: 0 }])
  })
  it('maps dates to trip days, with nothing outside the trip', () => {
    assert.equal(tripDay('2026-11-10', trip), 1)
    assert.equal(tripDay('2026-11-14', trip), 5)
    assert.equal(tripDay('2026-11-15', trip), null)
    assert.equal(tripDay('2026-11-09', trip), null)
    assert.equal(tripDay('2026-11-10', null), null)
  })
  it('works out what’s left per day of the trip', () => {
    assert.equal(budgetPace(10000, 4000, trip, '2026-11-12').daysLeft, 3)
    assert.equal(budgetPace(10000, 4000, trip, '2026-11-12').perDayLeft, 2000)
    assert.equal(budgetPace(10000, 4000, trip, '2026-11-01').daysLeft, 5)
    assert.equal(budgetPace(10000, 4000, trip, '2026-12-01').daysLeft, 0)
    assert.equal(budgetPace(10000, 12000, trip, '2026-11-12').perDayLeft, 0)
    assert.equal(budgetPace(10000, 4000, null, '2026-11-12').perDayLeft, null)
  })
})

describe('reading amounts', () => {
  it('reads what people type without float error', () => {
    assert.equal(parseAmount('19.99', 'USD'), 1999)
    assert.equal(parseAmount('0.07', 'USD'), 7)
    assert.equal(parseAmount('1,200', 'INR'), 120000)
    assert.equal(parseAmount('1,200.50', 'INR'), 120050)
    assert.equal(parseAmount('12,50', 'EUR'), 1250)
    assert.equal(parseAmount('1,200', 'JPY'), 1200)
    assert.equal(parseAmount('₹ 500', 'INR'), 50000)
    assert.equal(parseAmount('.5', 'USD'), 50)
    assert.equal(parseAmount('3000', 'JPY'), 3000)
    assert.equal(parseAmount('1.500', 'KWD'), 1500)
  })
  it('refuses what isn’t an amount', () => {
    for (const bad of ['', '.', 'abc', '1.2.3', '12.3456', '-5', '1e5']) assert.equal(parseAmount(bad, 'USD'), null, bad)
    assert.equal(parseAmount('12.5', 'JPY'), null)
  })
  it('round-trips through the edit form', () => {
    for (const [n, c] of [[120050, 'INR'], [1999, 'USD'], [100, 'USD'], [3000, 'JPY'], [1500, 'KWD'], [7, 'USD']] as const) {
      assert.equal(parseAmount(amountToInput(n, c), c), n)
    }
    assert.equal(amountToInput(120050, 'INR'), '1200.5')
    assert.equal(amountToInput(-1000, 'USD'), '-10')
  })
  it('reads adjustments, percents and shares', () => {
    assert.equal(parseSigned('-10', 'USD'), -1000)
    assert.equal(parseSigned('+10', 'USD'), 1000)
    assert.equal(parseSigned('−10', 'USD'), -1000)
    assert.equal(parseHundredths('33.33'), 3333)
    assert.equal(parseHundredths('1.5'), 150)
    assert.equal(parseHundredths('100'), 10000)
    assert.equal(parseHundredths('1.234'), null)
  })
})

describe('guessing a category', () => {
  it('reads common words', () => {
    assert.equal(guessCategory('Dinner at Ichiran'), 'food')
    assert.equal(guessCategory('Taxi to airport'), 'transport')
    assert.equal(guessCategory('Airbnb deposit'), 'stay')
    assert.equal(guessCategory('Skytree tickets'), 'activities')
    assert.equal(guessCategory('eSIM'), 'fees')
    assert.equal(guessCategory('asdf'), null)
  })
  it('goes by whichever word comes first', () => {
    assert.equal(guessCategory('Taxi to dinner'), 'transport')
    assert.equal(guessCategory('Coffee on the train'), 'food')
  })
})

describe('hardening', () => {
  it('two people paying and owing the same part net to exactly zero', () => {
    // an odd group-currency total used to leave a phantom 1-cent debt between them
    for (let i = 0; i < 2000; i++) {
      const e = expense(`e${i}`, 2001, { a: 1000, b: 1001 }, by('exact', { a: 1000, b: 1001 }), { currency: 'JPY', fxRate: 0.0067 })
      assert.deepEqual(Object.values(netBalances([e], [])).filter(Boolean), [], `e${i}`)
    }
  })
  it('refuses a converted total too big to add up safely', () => {
    assert.throws(() => computeExpense({ id: 'x', amount: 1e12, currency: 'JPY', fxRate: 1e4, payers: [{ memberId: 'a', amount: 1e12 }], split: equal('a') }, 'INR'), (e: SplitError) => e.code === 'too-large')
  })
  it('never hangs on balances that don’t sum to zero', () => {
    assert.deepEqual(simplifyDebts({ a: 500, b: 300 }), [])
    const many: MoneyMap = {}
    for (let i = 0; i < 20; i++) many[`m${i}`] = 100
    assert.deepEqual(simplifyDebts(many), [])
  })
  it('reads thousands separators as written in other countries', () => {
    assert.equal(parseAmount('150.000', 'VND'), 150000)
    assert.equal(parseAmount('1.500.000', 'VND'), 1500000)
    assert.equal(parseAmount('1.200,00', 'EUR'), 120000)
    assert.equal(parseAmount('1,200.00', 'USD'), 120000)
    assert.equal(parseAmount('1.200', 'EUR'), 120000)
    assert.equal(parseAmount('1.5', 'USD'), 150)
    assert.equal(parseAmount('1.500', 'KWD'), 1500) // three decimals is real here
    assert.equal(parseAmount('1,500', 'KWD'), 1500000)
    assert.equal(parseAmount('1,50', 'USD'), 150)
    assert.equal(parseAmount('1.2.3', 'USD'), null)
  })
})
