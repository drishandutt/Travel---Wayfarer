import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { initialState, isMember, reducer, snapshotOf, type Action, type TripState } from '../../src/state/tripStore'
import { cityById } from '../../src/data/cities'
import type { SharedPlan } from '../../src/trip/types'

// How a shared trip behaves on screen. The server enforces who can change what;
// this keeps the screen from pretending otherwise.

const tokyo = cityById('tokyo')!
const deck = tokyo.places.slice(0, 5).map((p, i) => ({ id: p.id, why: '', match: 1 - i / 10 }))
const ids = deck.map(c => c.id)

const plan = (over: Partial<SharedPlan> = {}): SharedPlan => ({
  phase: 'swipe',
  brief: { destination: 'tokyo', days: 2, travelers: 3, vibes: [] },
  deck,
  days: [],
  hotelScores: [],
  candidates: {},
  messages: [{ id: 'hello', role: 'ai', text: 'Hi' }],
  thoughts: [],
  ...over,
})

const member = (p: SharedPlan = plan(), votes: Record<string, 'like' | 'nope'> = {}, from: TripState = initialState) =>
  reducer(from, { type: 'shared-plan', plan: p, role: 'member', version: 1, votes })

describe('what a normal user’s screen allows', () => {
  it('ignores every way of changing the plan', () => {
    const s = member(plan({ phase: 'review' }))
    assert.equal(isMember(s), true)
    const attempts: Action[] = [
      { type: 'chat', role: 'user', text: 'hi' }, { type: 'brief', brief: { vibes: [] } }, { type: 'phase', phase: 'intake' },
      { type: 'replan' }, { type: 'remove-stop', id: 'x' }, { type: 'move-stop', id: 'x', toDay: 1 }, { type: 'shift-stop', id: 'x', dir: 1 },
      { type: 'add-stop', id: 'x', day: 1 }, { type: 'optimize-day', day: 1 }, { type: 'fill-gap', day: 1 }, { type: 'choose-hotel', id: 'x' },
      { type: 'start-deck' }, { type: 'chat-edit', text: 'add a day' }, { type: 'undo' }, { type: 'finish-deck' }, { type: 'planner', event: { type: 'plan-ready' } },
    ]
    for (const a of attempts) assert.equal(reducer(s, a), s, a.type)
  })
  it('still lets them look around', () => {
    const s = member(plan({ phase: 'review' }))
    assert.equal(reducer(s, { type: 'active-day', day: 1 }).activeDay, 1)
    assert.equal(reducer(s, { type: 'select-place', id: ids[0] }).selectedPlace, ids[0])
  })
  it('the admin isn’t held back', () => {
    const s = reducer(initialState, { type: 'shared-plan', plan: plan({ phase: 'intake' }), role: 'admin', version: 1, votes: {} })
    assert.equal(reducer(s, { type: 'chat', role: 'user', text: 'hi' }).messages.length, s.messages.length + 1)
  })
  it('leaving a trip clears the role, so someone’s own next trip is theirs to edit', () => {
    const s = reducer(member(), { type: 'reset' })
    assert.equal(s.shared, undefined)
    assert.equal(reducer(s, { type: 'chat', role: 'user', text: 'hi' }).messages.length, s.messages.length + 1)
  })
})

describe('the voting deck', () => {
  it('shows only what you haven’t decided, on the tiles everyone shares', () => {
    const s = member(plan(), { [ids[0]]: 'like', [ids[2]]: 'nope' })
    assert.equal(s.phase, 'swipe')
    assert.deepEqual(s.deck.map(c => c.id), [ids[1], ids[3], ids[4]])
    assert.deepEqual(s.sharedDeck.map(c => c.id), ids)
    assert.equal(s.deckIndex, 0)
    assert.equal(s.candidates[ids[0]].verdict, 'keep')
    assert.equal(s.candidates[ids[2]].verdict, 'drop')
    assert.equal(s.candidates[ids[1]].verdict, 'consider')
  })
  it('having voted on everything means the deck is finished, not restarted', () => {
    const s = member(plan(), Object.fromEntries(ids.map(id => [id, 'like' as const])))
    assert.equal(s.deck.length, 0)
    assert.ok(s.deckIndex >= s.deck.length)
  })
  it('keeps your place when the plan updates underneath you', () => {
    let s = member()
    s = reducer(s, { type: 'swipe', like: true })
    s = reducer(s, { type: 'swipe', like: false })
    assert.equal(s.deckIndex, 2)
    const again = member(plan({ messages: [{ id: 'hello', role: 'ai', text: 'Hi' }, { id: 'x', role: 'ai', text: 'Later' }] }), { [ids[0]]: 'like' }, s)
    assert.equal(again.deckIndex, 2)
    assert.equal(again.picks[ids[1]], 'nope', 'what you’ve just done isn’t thrown away')
    assert.equal(again.messages.length, 2)
  })
  it('closes by itself when the admin moves on', () => {
    const voting = member()
    assert.equal(voting.shared?.voting, true)
    const moved = member(plan({ phase: 'planning' }), {}, voting)
    assert.equal(moved.phase, 'planning')
    assert.equal(moved.shared?.voting, false)
  })
  it('a deck someone opened over a finished plan stays open until they close it', () => {
    const review = plan({ phase: 'review' })
    const looking = member(review)
    assert.equal(looking.phase, 'review')
    const open = reducer(looking, { type: 'shared-plan', plan: review, role: 'member', version: 1, votes: {}, voting: true })
    assert.equal(open.phase, 'swipe')
    const updated = member({ ...review, messages: [{ id: 'y', role: 'ai', text: 'New' }] }, {}, open)
    assert.equal(updated.phase, 'swipe', 'an edit by the admin doesn’t yank them out')
    assert.equal(updated.messages[0].id, 'y')
    const closed = reducer(updated, { type: 'shared-plan', plan: review, role: 'member', version: 1, votes: {}, voting: false })
    assert.equal(closed.phase, 'review')
    assert.equal(closed.deck.length, 0)
  })
})

describe('an admin picking a trip back up', () => {
  const admin = (p: SharedPlan) => reducer(initialState, { type: 'shared-plan', plan: p, role: 'admin', version: 4, votes: {} })
  const isClean = (s: TripState) => JSON.stringify(snapshotOf(s)) === s.shared?.synced

  it('a plan from the server has nothing to send back', () => {
    for (const phase of ['intake', 'swipe', 'review', 'final'] as const) assert.ok(isClean(admin(plan({ phase }))), phase)
    assert.equal(admin(plan()).shared?.base, 4)
  })
  it('an edit is a change', () => {
    const s = admin(plan({ phase: 'review' }))
    assert.ok(!isClean(reducer(s, { type: 'chat', role: 'user', text: 'hi' })))
  })
  it('a planner that died in a closed tab doesn’t strand them, and the group is told', () => {
    const day = { day: 1 } as unknown as SharedPlan['days'][number]
    const drawn = admin(plan({ phase: 'planning', days: [{ ...day, stops: [], legs: [] }] }))
    assert.equal(drawn.phase, 'review')
    assert.ok(!isClean(drawn), 'members are still looking at “mapping”')
    assert.equal(admin(plan({ phase: 'planning' })).phase, 'swipe', 'nothing drawn yet: back to the deck')
    assert.equal(admin(plan({ phase: 'planning', deck: [] })).phase, 'intake')
    assert.equal(admin(plan({ phase: 'hotels', days: [{ ...day, stops: [], legs: [] }] })).phase, 'review', 'the hotel search is gone too')
  })
  it('someone in the group sees what’s really happening', () => {
    assert.equal(member(plan({ phase: 'planning' })).phase, 'planning')
    assert.equal(member(plan({ phase: 'hotels' })).phase, 'hotels')
  })
  it('a normal user with no plan yet doesn’t look at a copy this browser kept', () => {
    const local = { ...initialState, phase: 'review' as const, brief: { destination: 'tokyo', vibes: [] } }
    const s = reducer(local, { type: 'shared-role', role: 'member', version: 0 })
    assert.equal(s.phase, 'intake')
    assert.equal(isMember(s), true)
    const mine = reducer(local, { type: 'shared-role', role: 'admin', version: 0 })
    assert.equal(mine.phase, 'review', 'the admin carries on with theirs')
  })
})

describe('places that have gone from the city’s data', () => {
  const tiles = [...deck, { id: 'closed-down', why: '', match: 0.1 }]
  it('aren’t dealt, and don’t stop anyone finishing the deck', () => {
    const s = member(plan({ deck: tiles }))
    assert.ok(!s.deck.some(c => c.id === 'closed-down'))
    assert.deepEqual(s.sharedDeck.map(c => c.id), ids)
  })
  it('a swipe that lands on one passes over it rather than pinning nothing', () => {
    // the five before it already swiped
    const s = { ...member(), deck: tiles, deckIndex: 5, picks: Object.fromEntries(tiles.slice(0, 5).map(c => [c.id, 'like' as const])) }
    const next = reducer(s, { type: 'swipe', like: true })
    assert.equal(next.deckIndex, 6)
    assert.ok(Object.values(next.candidates).every(c => c.place))
  })
})

describe('what gets published', () => {
  it('a private mini deck over the plan stays private', () => {
    const base = { ...initialState, phase: 'swipe' as const, sharedDeck: deck, deck: deck.slice(0, 1), deckMode: { returnPhase: 'review' as const, label: 'Try' } }
    const snap = snapshotOf(base)
    assert.equal(snap.phase, 'review')
    assert.deepEqual(snap.deck.map(c => c.id), ids, 'the group keeps the shared tiles')
  })
  it('stays inside what the server accepts, however long the trip’s been running', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `${i}`, role: 'ai' as const, text: 'x'.repeat(9000) }))
    const thoughts = Array.from({ length: 100 }, (_, i) => ({ id: `${i}`, text: 't', tone: 'info' as const }))
    const snap = snapshotOf({ ...initialState, messages: many, thoughts })
    assert.ok(snap.messages.length <= 80)
    assert.ok(snap.messages.every(m => m.text.length <= 5000))
    assert.ok(snap.thoughts.length <= 40)
  })
})
