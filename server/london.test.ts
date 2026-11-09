import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cityById, findCity, tripCity } from '../src/data/cities'
import { buildDeck, scorePlace, shortlist, SHORTLIST } from '../src/planner/core'
import { MockPlanner } from '../src/planner/mockPlanner'
import { applyEdit, type PlanSlice } from '../src/planner/edits'
import { contextOf, runTool } from '../src/agent/run'
import { extractBrief } from '../src/planner/intake'
import { initialState } from '../src/state/tripStore'
import type { DayPlan, PlannerEvent, TripBrief } from '../src/types'
import { blurbOf, plain, priceOf } from '../scripts/build-london.mjs'

const brief: TripBrief = { destination: 'london', days: 3, vibes: ['history', 'food'], travelers: 2 }
const london = cityById('london')!

async function plan(b: TripBrief): Promise<DayPlan[]> {
  const days: DayPlan[] = []
  const ctrl = new AbortController()
  for await (const e of new MockPlanner(1000).planItinerary(b, ctrl.signal) as AsyncGenerator<PlannerEvent>) if (e.type === 'day') days.push(e.plan)
  return days
}

describe('London', () => {
  it('reads a London brief, “comfort budget” included', () => {
    const b = extractBrief('3 days in London for 2, history and food, comfort budget', { vibes: [] })
    assert.equal(b.destination, 'london')
    assert.equal(b.budgetTier, 'comfort')
  })

  it('is a city the app knows, with a big catalog and hotels in each budget', () => {
    assert.equal(findCity('a weekend in London')?.id, 'london')
    assert.ok(london.places.length > 1000)
    for (const tier of ['shoestring', 'comfort', 'luxury']) assert.ok(london.hotels.some(h => h.tier === tier), tier)
    assert.equal(new Set(london.places.map(p => p.id)).size, london.places.length)
  })

  it('weighs a shortlist, famous places first, with every kind of place in it', () => {
    const list = shortlist(london.places, brief)
    assert.equal(list.length, SHORTLIST)
    for (const k of ['food', 'bar', 'museum', 'park', 'sight']) assert.ok(list.some(p => p.kind === k), k)
    assert.ok(list.slice(0, 20).some(p => p.name === 'Tower of London'))
    // a small hand-picked city passes through whole
    assert.equal(shortlist(cityById('tokyo')!.places, { ...brief, destination: 'tokyo' }).length, cityById('tokyo')!.places.length)
  })

  it('keeps the travellers’ own finds in the shortlist', () => {
    const own = { ...london.places[1500], id: 'my-tiny-bar', rank: undefined, custom: { from: 'name' as const } }
    const city = tripCity({ ...brief, customPlaces: [own] })!
    assert.ok(shortlist(city.places, brief).some(p => p.id === 'my-tiny-bar'))
  })

  it('deals a deck of its best matches, not all of them', () => {
    const deck = buildDeck(shortlist(london.places, brief, 40), brief)
    assert.equal(deck.length, 40)
  })

  it('plans three full days', async () => {
    const days = await plan(brief)
    assert.equal(days.length, 3)
    for (const d of days) assert.ok(d.stops.length >= 3, `Day ${d.day} has ${d.stops.length} stops`)
    const names = days.flatMap(d => d.stops.map(s => s.place.name))
    assert.ok(names.some(n => /Tower of London|British Museum|Westminster Abbey|St Paul/.test(n)), names.join(', '))
  })

  it('takes edits by name from the whole catalog', async () => {
    const days = await plan(brief)
    const slice: PlanSlice = { brief, days, hotelScores: [], candidates: {}, picks: {} }
    const added = applyEdit(slice, 'add Tate Modern to day 2')
    assert.ok(added.plan.days[1].stops.some(s => s.place.name === 'Tate Modern'), added.plan.days[1].stops.map(s => s.place.name).join(', '))
    const kew = applyEdit(slice, 'add Kew Gardens')
    assert.ok(kew.plan.days.some(d => d.stops.some(s => /Kew|Royal Botanic/.test(s.place.name))))
  })

  it('lets the assistant search the whole catalog', async () => {
    const state = { ...initialState, brief, phase: 'review' as const, days: [] }
    const host = { state: () => state, dispatch: () => {}, trip: () => null, ensureGroup: async () => '', confirm: async () => false }
    const jazz = await runTool({ id: '1', name: 'search_places', args: { query: 'jazz', kind: 'bar', near_place_id: null } }, host)
    assert.match(jazz, /Ronnie Scott/)
    const near = await runTool({ id: '2', name: 'search_places', args: { query: null, kind: 'food', near_place_id: 'ldn-tower-of-london' } }, host)
    assert.match(near, /km away/)
    assert.ok(near.split('\n').length <= 15)
  })

  it('tells the assistant about the best places and that there are more', () => {
    const text = contextOf({ ...initialState, brief, phase: 'review', days: [] }, null)
    assert.match(text, /the best 150 of \d+ for this trip; search_places finds the rest/)
    assert.ok(text.length < 39_000)
  })
})

describe('how well they know the city', () => {
  const fame = (days: DayPlan[]) => { const s = days.flatMap(d => d.stops.map(x => x.place.rank ?? 0)); return s.reduce((a, b) => a + b, 0) / s.length }
  for (const city of ['london', 'tokyo', 'lisbon']) {
    it(`gives a first-timer the famous places and a local the quieter ones in ${city}`, async () => {
      const b = { destination: city, days: 2, vibes: ['culture' as const], travelers: 2 }
      const first = await plan({ ...b, familiarity: 0 })
      const local = await plan({ ...b, familiarity: 1 })
      assert.ok(fame(first) - fame(local) > 0.12, `first-timer ${fame(first).toFixed(2)} vs local ${fame(local).toFixed(2)}`)
    })
  }
  it('says why on the swipe card', () => {
    const b = { ...brief, destination: 'tokyo', familiarity: 1 }
    assert.equal(scorePlace(cityById('tokyo')!.places.find(p => p.id === 'tk-yanaka')!, { ...b, vibes: [] }).why, 'off the tourist trail')
    assert.equal(scorePlace(cityById('tokyo')!.places.find(p => p.id === 'tk-sensoji')!, { ...b, vibes: [], familiarity: 0 }).why, 'a must on a first visit')
  })
})

describe('reading Wikivoyage listings', () => {
  it('turns wikitext into plain words', () => {
    assert.equal(plain("The '''[[Tower of London|Tower]]''' has {{km|2}} of walls<ref>x</ref>."), 'The Tower has 2 of walls.')
  })
  it('prices from the section, then from the listing', () => {
    assert.equal(priceOf({ price: '', band: 'splurge', type: 'eat' }, 'food'), 3)
    assert.equal(priceOf({ price: 'Free', type: 'see' }, 'museum'), 0)
    assert.equal(priceOf({ price: 'Adults £33.60, children £16.80', type: 'see' }, 'sight'), 2)
  })
  it('keeps a card’s blurb to one short sentence', () => {
    assert.equal(blurbOf('Magnificent bridge. Opened in 1894.', 'sight', 'City of London'), 'Magnificent bridge.')
    assert.equal(blurbOf('', 'bar', 'Soho'), 'Bar in Soho.')
  })
})
