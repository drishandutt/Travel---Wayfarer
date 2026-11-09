import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cityById } from '../src/data/cities'
import { PACE, dayShape, scoreHotel } from '../src/planner/core'
import { estimateTravel } from '../src/planner/geo'
import { MockPlanner } from '../src/planner/mockPlanner'
import { SLIDERS, sliderPatch, tuningLines } from '../src/planner/sliders'
import type { DayPlan, Place, PlannerEvent, TripBrief } from '../src/types'

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
