import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cityById } from '../src/data/cities'
import { PACE, dayShape, laneOf, scoreHotel } from '../src/planner/core'
import { estimateTravel } from '../src/planner/geo'
import { MockPlanner } from '../src/planner/mockPlanner'
import { SLIDERS, sliderPatch, tuningLines } from '../src/planner/sliders'
import type { DayPlan, Place, PlannerEvent, TripBrief } from '../src/types'
import { initialState, reducer, type TripState } from '../src/state/tripStore'

// Each of the chat's sliders, pushed to its ends, should move the plan the way its label says.

const base: TripBrief = { destination: 'london', days: 3, vibes: [], travelers: 2 }

async function plan(b: TripBrief): Promise<DayPlan[]> {
  const days: DayPlan[] = []
  for await (const e of new MockPlanner(1000).planItinerary(b, new AbortController().signal) as AsyncGenerator<PlannerEvent>) if (e.type === 'day') days.push(e.plan)
  return days
}
const places = (days: DayPlan[]): Place[] => days.flatMap(d => d.stops.map(s => s.place))
const share = (days: DayPlan[], test: (p: Place) => boolean) => places(days).filter(test).length / places(days).length
const set = (key: string, v: number): TripBrief => ({ ...base, ...sliderPatch(SLIDERS.find(s => s.key === key)!, v) })

describe('the chat’s sliders', () => {
  it('change nothing until they’re moved', () => {
    const shape = dayShape(base)
    assert.deepEqual({ perDay: shape.perDay, buffer: shape.buffer, start: shape.start }, PACE.balanced)
    assert.equal(shape.walkKm, 1.4)
    assert.equal(shape.visit, 1)
    assert.deepEqual(tuningLines(base), [])
  })

  it('pace: three stops a day to seven, keeping the named pace in step', () => {
    assert.equal(dayShape(set('paceLevel', 0)).perDay, 3)
    assert.equal(dayShape(set('paceLevel', 1)).perDay, 7)
    assert.equal(set('paceLevel', 0).pace, 'slow')
    assert.equal(set('paceLevel', 1).pace, 'packed')
  })

  it('early bird or night owl: when the day starts, and what fills the evening', async () => {
    assert.equal(dayShape(set('rhythm', 0)).start, 7 * 60 + 30)
    assert.equal(dayShape(set('rhythm', 1)).start, 10 * 60 + 30)
    const late = (p: Place) => p.bestAt === 'night'
    assert.ok(share(await plan(set('rhythm', 1)), late) > share(await plan(set('rhythm', 0)), late))
  })

  it('plan or wander: wanderers get a stop fewer and longer free stretches', () => {
    const wander = dayShape(set('structure', 1))
    const planned = dayShape(set('structure', 0))
    assert.equal(wander.perDay, planned.perDay - 1)
    assert.ok(wander.buffer >= planned.buffer + 25)
  })

  it('walking: how far before a ride', () => {
    const a: [number, number] = [-0.1276, 51.5072]
    const b: [number, number] = [-0.1276, 51.5072 + 0.012] // ~1.7 km on foot
    assert.equal(estimateTravel(a, b, dayShape(set('walking', 0)).walkKm).mode, 'transit')
    assert.equal(estimateTravel(a, b, dayShape(set('walking', 1)).walkKm).mode, 'walk')
  })

  it('food focus: a foodie trip eats more', async () => {
    const eats = (p: Place) => p.kind === 'food' || p.kind === 'cafe'
    assert.ok(share(await plan(set('foodie', 1)), eats) > share(await plan(set('foodie', 0)), eats))
  })

  it('crowds: avoiding them drops the busiest sights', async () => {
    const busiest = (p: Place) => (p.rank ?? 0) >= 0.85
    assert.ok(share(await plan(set('crowds', 1)), busiest) < share(await plan(set('crowds', 0)), busiest))
  })

  it('where the money goes: a nicer hotel, or a simpler one', async () => {
    const days = await plan(base)
    const best = (b: TripBrief) => cityById('london')!.hotels.map(h => scoreHotel(h, b, days)).sort((x, y) => y.total - x.total)[0].hotel.nightly
    assert.ok(best(set('splurgeOn', 0)) > best(set('splurgeOn', 1)))
  })

  it('energy: adventurous trips are livelier than chill ones', async () => {
    const lively = (p: Place) => p.tags.includes('adventure') || p.tags.includes('nightlife')
    assert.ok(share(await plan({ ...set('energy', 1), destination: 'tokyo' }), lively) > share(await plan({ ...set('energy', 0), destination: 'tokyo' }), lively))
  })

  it('kids: no bars or late nights, a stop fewer, shorter visits', async () => {
    const b = set('kids', 1)
    const days = await plan({ ...b, rhythm: 1, vibes: ['nightlife'] })
    assert.equal(places(days).filter(p => p.kind === 'bar' || p.bestAt === 'night').length, 0)
    assert.equal(dayShape(b).perDay, dayShape(base).perDay - 1)
    assert.ok(dayShape(b).visit < 1)
  })

  it('tells the planners what was moved, in words', () => {
    assert.deepEqual(tuningLines({ ...base, rhythm: 1, kids: 0 }), [
      'Day rhythm: Night owl (Out from 10:30, bars and late spots each night)',
      'Kids: No kids (Plan for adults)',
    ])
  })
})

describe('re-planning when the sliders move over a plan', () => {
  it('keeps what they liked, never brings back what they skipped, and follows the new settings', async () => {
    const before = await plan(base)
    const liked = before[0].stops.slice(0, 2).map(s => s.place.id)
    const skipped = before[1].stops.map(s => s.place.id)
    const tuned: TripBrief = { ...base, familiarity: 1, rhythm: 1 }
    const after: DayPlan[] = []
    for await (const e of new MockPlanner(1000).planItinerary(tuned, new AbortController().signal, { liked, rejected: skipped, fresh: true }) as AsyncGenerator<PlannerEvent>) if (e.type === 'day') after.push(e.plan)
    const ids = places(after).map(p => p.id)
    for (const id of liked) assert.ok(ids.includes(id), `kept ${id}`)
    for (const id of skipped) assert.ok(!ids.includes(id), `left out ${id}`)
    assert.ok(after.every(d => d.stops[0].arrive >= 10 * 60 + 30), 'a night owl’s days start at 10:30')
    assert.ok(after.length === 3)
  })

  it('doesn’t choose for them: re-times the days and deals options to swipe', async () => {
    const days = await plan(base)
    const planned = days.flatMap(d => d.stops.map(x => x.place.id))
    const skipped = 'ldn-tate-modern'
    const s: TripState = { ...initialState, brief: base, phase: 'review', days, picks: { [skipped]: 'nope' } }
    const next = reducer(s, { type: 'retune', brief: { ...base, rhythm: 1, foodie: 1 } })
    assert.equal(next.phase, 'swipe')
    assert.ok(next.deckMode, 'a deck over the plan, which returns to it')
    // same places, new times
    assert.deepEqual(next.days.map(d => d.stops.map(x => x.place.id)), days.map(d => d.stops.map(x => x.place.id)))
    assert.ok(next.days.every(d => d.stops[0].arrive >= 10 * 60 + 30))
    // options: nothing already planned or skipped, places first and then food and drink
    const ids = next.deck.map(c => c.id)
    assert.ok(ids.length > 0 && ids.every(id => !planned.includes(id) && id !== skipped))
    const lanes = ids.map(id => laneOf(cityById('london')!.places.find(p => p.id === id)!))
    assert.ok(lanes.includes('places') && lanes.includes('food'))
    assert.equal(lanes.indexOf('food'), lanes.lastIndexOf('places') + 1, 'places, then food')
    // keeping one adds it; nothing else changes
    const kept = reducer({ ...next, picks: { ...next.picks, [ids[0]]: 'like' } }, { type: 'finish-deck' })
    assert.ok(kept.days.some(d => d.stops.some(x => x.place.id === ids[0])))
    assert.equal(kept.days.flatMap(d => d.stops).length, planned.length + 1)
  })

  it('“undo” brings the old settings and times back', async () => {
    const days = await plan(base)
    const s: TripState = { ...initialState, brief: base, phase: 'review', days }
    const next = reducer(reducer(s, { type: 'retune', brief: { ...base, rhythm: 1 } }), { type: 'finish-deck', cancel: true })
    const back = reducer(next, { type: 'undo' })
    assert.equal(back.brief.rhythm, undefined)
    assert.deepEqual(back.days.map(d => d.stops[0].arrive), days.map(d => d.stops[0].arrive))
  })

  it('only re-plans a plan', () => {
    const s: TripState = { ...initialState, brief: base, phase: 'intake' }
    assert.equal(reducer(s, { type: 'retune', brief: { ...base, kids: 1 } }), s)
  })
})

describe('a full day', () => {
  it('isn’t padded past the pace, even for a night owl', async () => {
    const b: TripBrief = { destination: 'tokyo', days: 3, vibes: ['food', 'culture'], travelers: 2, rhythm: 1, familiarity: 1 }
    for (const d of await plan(b)) assert.ok(d.stops.length <= dayShape(b).perDay + 1, `Day ${d.day} has ${d.stops.length} stops`)
  })
})

describe('two decks: places, then food and drink', () => {
  const start = (): TripState => reducer({ ...initialState, brief: base, phase: 'intake' }, { type: 'start-deck' })
  const laneAt = (s: TripState, i = s.deckIndex) => laneOf(cityById('london')!.places.find(p => p.id === s.deck[i].id)!)

  it('deals places first, then food and drink', () => {
    const s = start()
    assert.equal(laneAt(s, 0), 'places')
    assert.equal(laneAt(s, s.deck.length - 1), 'food')
  })

  it('switches deck, keeps swiping in it, and undo goes back to the last card swiped', () => {
    let s = start()
    s = reducer(s, { type: 'swipe', like: true })
    const firstPlace = s.deck[0].id
    s = reducer(s, { type: 'deck-lane', lane: 'food' })
    assert.equal(laneAt(s), 'food')
    const firstFood = s.deck[s.deckIndex].id
    s = reducer(s, { type: 'swipe', like: true })
    assert.equal(laneAt(s), 'food', 'stays in the food deck')
    s = reducer(s, { type: 'undo-swipe' })
    assert.equal(s.deck[s.deckIndex].id, firstFood)
    assert.equal(s.picks[firstFood], undefined)
    assert.equal(s.picks[firstPlace], 'like')
    s = reducer(s, { type: 'deck-lane', lane: 'places' })
    assert.equal(laneAt(s), 'places')
    assert.notEqual(s.deck[s.deckIndex].id, firstPlace, 'the next undecided place, not one already swiped')
  })

  it('moves on to the other deck when one runs out, then ends', () => {
    let s = start()
    for (let i = 0; i < s.deck.length; i++) s = reducer(s, { type: 'swipe', like: false })
    assert.equal(s.deckIndex, s.deck.length)
    assert.ok(s.deck.every(c => s.picks[c.id] === 'nope'))
  })
})
