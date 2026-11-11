import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import type { City, PlannerEvent, TripBrief } from '../src/types'
import { closedDays, closedOnDay, closedStops, sunset, weekdayOf } from '../src/planner/when'
import { moodFit, moodOf, hasMood } from '../src/planner/story'
import { buildDay, scorePlace } from '../src/planner/core'
import { addCatalogPlaces, cityById, tripCity } from '../src/data/cities'
import { reducer, initialState } from '../src/state/tripStore'
import { setOpenAIKey } from './openai'
import { findByVibe, focusesOf, fromSearch } from './cities/vibeSearch'
import { kindFit, laneDeck, laneOf } from '../src/planner/core'
import { applyStory } from '../src/planner/story'
import { planWithModel } from './planAgent'

describe('calendar time', () => {
  it('reads which weekdays a place is shut from its opening hours, and nothing it can’t read', () => {
    assert.deepEqual(closedDays('Tu-Su 12:00-23:00'), [1])
    assert.deepEqual(closedDays('Mo-Fr 09:00-17:00; Sa 10:00-14:00'), [0])
    assert.deepEqual(closedDays('Fr-Mo 18:00-02:00'), [2, 3, 4], 'a range over the weekend wraps')
    assert.deepEqual(closedDays('We-Su 12:00-15:00,19:00-23:00'), [1, 2])
    assert.deepEqual(closedDays('Mo off'), [1], 'only the day said')
    assert.deepEqual(closedDays('Mo-Su 09:00-17:00; PH off'), [])
    assert.deepEqual(closedDays('24/7'), [])
    assert.equal(closedDays('Mo-Fr 09:00-17:00; Jan off'), undefined)
    assert.equal(closedDays('by appointment'), undefined)
    assert.equal(closedDays(undefined), undefined)
  })

  it('knows each day’s weekday, and flags a stop on a day it’s shut', () => {
    const brief: TripBrief = { destination: 'tokyo', vibes: [], startDate: '2026-11-23' } // a Monday
    assert.equal(weekdayOf(brief, 1), 1)
    assert.equal(weekdayOf(brief, 2), 2)
    const city = tripCity(brief)!
    const shut = { ...city.places[0], hours: 'Tu-Su 11:00-22:00' }
    assert.equal(closedOnDay(shut, brief, 1), true)
    assert.equal(closedOnDay(shut, brief, 2), false)
    assert.equal(closedOnDay(shut, { startDate: undefined }, 1), false, 'no dates, no claims')
    assert.deepEqual(closedStops(buildDay(1, [shut, city.places[1]], brief), brief).map(p => p.id), [shut.id])
  })

  it('works out sunset in the city’s own time', () => {
    const at = (c: Pick<City, 'center' | 'essentials'>, d: string) => sunset(c, d)!
    const mumbai = { center: [72.8487, 19.0318] as [number, number], essentials: { timezone: 'Asia/Kolkata' } as City['essentials'] }
    const london = { center: [-0.1276, 51.5072] as [number, number], essentials: { timezone: 'Europe/London' } as City['essentials'] }
    const near = (m: number, h: number, min: number) => Math.abs(m - (h * 60 + min)) <= 4
    assert.ok(near(at(mumbai, '2026-11-24'), 17, 59), `${at(mumbai, '2026-11-24')}`)
    assert.ok(near(at(london, '2026-06-21'), 21, 21))
    assert.ok(near(at(london, '2026-12-21'), 15, 53))
  })
})

describe('matching places to the story', () => {
  const brief: TripBrief = { vibes: [], story: { feel: ['romantic', 'live music'], people: [{ who: 'girlfriend', notes: 'loves cocktails and jazz' }], avoid: ['clubs'] } }

  it('scores a place on its mood words against what they want and want to avoid', () => {
    assert.ok(moodFit({ name: 'x', moods: ['jazz', 'cocktails', 'intimate'] }, brief).score > 0)
    assert.equal(moodFit({ name: 'x', moods: ['jazz', 'cocktails'] }, brief).match, 'cocktail + jazz')
    assert.ok(moodFit({ name: 'x', moods: ['club', 'loud'] }, brief).score < 0)
    assert.equal(moodFit({ name: 'x', moods: ['jazz'] }, { vibes: [] }).score, 0, 'no story, no opinion')
  })

  it('lifts a matching place up the deck and says why', () => {
    const city = tripCity({ destination: 'tokyo', vibes: [] })!
    const base = { ...city.places[0], moods: undefined, keywords: undefined }
    const jazz = { ...base, moods: ['jazz', 'cocktails'] }
    const b = { ...brief, destination: 'tokyo' }
    assert.ok(scorePlace(jazz, b).score > scorePlace(base, b).score)
    assert.match(scorePlace(jazz, b).why, /fits your cocktail \+ jazz/)
  })

  it('makes a stable key from the mood, and only searches when there is one', () => {
    assert.equal(moodOf({ vibes: [], story: { feel: ['fun', 'romantic'] } }), moodOf({ vibes: [], story: { feel: ['romantic', 'fun'] } }))
    assert.equal(hasMood({ vibes: ['food'] }), false)
    assert.equal(hasMood(brief), true)
  })

  it('keeps the reason a place is in the plan on the trip, so edits keep it', () => {
    const city = tripCity({ destination: 'tokyo', vibes: [] })!
    const day = buildDay(1, city.places.slice(0, 2), { destination: 'tokyo', vibes: [] })
    const plan = { ...day, stops: day.stops.map((s, i) => (i === 0 ? { ...s, why: 'you said jazz' } : s)) }
    const s = reducer({ ...initialState, brief: { destination: 'tokyo', vibes: [] } }, { type: 'planner', event: { type: 'day', plan } })
    assert.deepEqual(s.brief.why, { [city.places[0].id]: 'you said jazz' })
  })
})

describe('searching the web for places that fit the mood', () => {
  it('counts a page only if the search returned it, or its site', () => {
    const sources = new Set(['https://www.timeout.com/mumbai/bars', 'https://cntraveller.in/story/best-rooftops/'])
    assert.ok(fromSearch('https://timeout.com/mumbai/bars?x=1', sources))
    assert.ok(fromSearch('https://www.timeout.com/mumbai/restaurants/olive', sources), 'another page on a site it searched')
    assert.ok(!fromSearch('https://madeup.example/olive', sources))
    assert.ok(!fromSearch('', sources))
  })
})

// OpenAI and OpenStreetMap, faked at fetch.
const realFetch = globalThis.fetch
describe('the mood search, end to end', { skip: Boolean(process.env.ANTHROPIC_API_KEY) && 'Claude is set here' }, () => {
  after(() => { globalThis.fetch = realFetch; setOpenAIKey(null) })
  const city = cityById('tokyo')!
  const near = (dx: number) => ({ lon: String(city.center[0] + dx), lat: String(city.center[1] + dx) })

  it('keeps only sourced places the map can find, adds them to the city, and remembers the search', async () => {
    let searches = 0
    const asked: string[] = []
    globalThis.fetch = (async (url: string) => {
      const u = String(url)
      if (u.includes('nominatim')) {
        const q = new URL(u).searchParams.get('q') ?? ''
        asked.push(q)
        if (/Nowhere/.test(q)) return new Response('[]', { status: 200 })
        const dx = q.startsWith('Jazz') ? 0.01 : 0.02
        return new Response(JSON.stringify([{ ...near(dx), name: q.split(',')[0], display_name: q, category: 'amenity', type: q.startsWith('Jazz') ? 'bar' : 'restaurant', importance: 0.2, address: { suburb: 'Shibuya' }, extratags: { opening_hours: 'Tu-Su 18:00-02:00' } }]), { status: 200 })
      }
      searches++
      const places = [
        { name: 'Jazz Kissa Test', area: 'Shibuya', kind: 'bar', why: 'Vinyl jazz and cocktails, made for the two of you.', order: 'The house highball', arrive: 'Before 8 for the corner seats', move: 'Ask for a request slip', heads: 'Cash only', price: 2, best_at: 'night', minutes: 90, moods: ['jazz', 'cocktails', 'intimate'], source_url: 'https://www.timeout.com/tokyo/bars/jazz-kissa' },
        { name: 'Invented Place', area: 'Ginza', kind: 'food', why: 'x', order: '', arrive: '', move: '', heads: '', price: 2, best_at: 'evening', minutes: 60, moods: ['romantic'], source_url: 'https://made.up/page' },
        { name: 'Nowhere Diner', area: 'Ginza', kind: 'food', why: 'x', order: '', arrive: '', move: '', heads: '', price: 2, best_at: 'evening', minutes: 60, moods: ['romantic'], source_url: 'https://www.timeout.com/tokyo/x' },
      ]
      const output = [
        { type: 'web_search_call', id: 'ws', status: 'completed', action: { type: 'search', query: 'jazz bars tokyo', sources: [{ type: 'url', url: 'https://www.timeout.com/tokyo/bars' }] } },
        { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ places }), annotations: [] }] },
      ]
      return new Response(JSON.stringify({ id: 'resp_v', object: 'response', created_at: 0, status: 'completed', model: 'test', output }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    setOpenAIKey('sk-test')

    const brief: TripBrief = { destination: 'tokyo', vibes: [], story: { feel: ['jazz', 'cocktails'], people: [{ who: 'girlfriend', notes: 'loves jazz' }] } }
    const out = await findByVibe('tokyo', brief, null)
    assert.equal(out.cached, false)
    const first = searches
    assert.equal(first, focusesOf(brief).length, 'one search per focus')
    assert.deepEqual(out.places.map(p => p.name), ['Jazz Kissa Test'], 'the made-up source and the place the map can’t find are dropped')
    const p = out.places[0]
    assert.equal(p.found?.via, 'vibe')
    assert.equal(p.tips?.move, 'Ask for a request slip')
    assert.equal(p.hours, 'Tu-Su 18:00-02:00')
    assert.equal(p.source, 'https://www.timeout.com/tokyo/bars/jazz-kissa')
    assert.ok(p.tags.includes('nightlife'))
    assert.ok(cityById('tokyo')!.places.some(x => x.id === p.id), 'it joined the city')
    assert.ok(!asked.some(q => /Invented/.test(q)), 'an unsourced place isn’t even looked up')

    // asked again while the first is remembered (in memory here; the database in production): no new search
    const again = await findByVibe('tokyo', brief, null)
    assert.equal(searches, first, 'remembered: no new searches')
    assert.equal(again.places[0]?.id ?? p.id, p.id)
  })

  it('tells the model planner each place’s hours, the weekdays and sunsets, and brings back closures', async () => {
    const shut = { ...cityById('tokyo')!.places[0], hours: 'Tu-Su 11:00-22:00' }
    const open = cityById('tokyo')!.places[1]
    const bodies: { input: unknown }[] = []
    let n = 0
    const reply = (output: unknown[]) => new Response(JSON.stringify({ id: `r${++n}`, object: 'response', created_at: 0, status: 'completed', model: 'test', output }), { status: 200, headers: { 'content-type': 'application/json' } })
    const call = (name: string, args: unknown) => ({ type: 'function_call', id: `fc${n}`, call_id: `c_${name}`, name, arguments: JSON.stringify(args), status: 'completed' })
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      if (n === 0) return reply([call('shortlist_places', { narration: 'n', keep: [{ id: shut.id, reason: 'you said culture' }, { id: open.id, reason: 'r' }], drop: [] })])
      if (n === 1) return reply([call('commit_day', { narration: 'n', day: 1, title: 'T', start_time: '10:00', stop_ids: [shut.id, open.id] })])
      return reply([call('finish_plan', { narration: 'done' })])
    }) as typeof fetch
    setOpenAIKey('sk-test')
    const original = city.places[0]
    addCatalogPlaces('tokyo', [shut])
    try {
      const events: PlannerEvent[] = []
      for await (const e of planWithModel({ destination: 'tokyo', days: 1, vibes: [], startDate: '2026-11-23' }, new AbortController().signal, { liked: [shut.id, open.id], rejected: [] })) events.push(e)
      const opening = JSON.stringify(bodies[0].input)
      assert.match(opening, /hours: Tu-Su 11:00-22:00/)
      assert.match(opening, /day 1 is Mon 23 Nov/)
      assert.match(opening, /Sunset: day 1 16:[23]\d/)
      assert.match(JSON.stringify(bodies[2].input), /usually closed on Mondays/)
      const day = events.find(e => e.type === 'day')
      assert.equal(day?.type === 'day' && day.plan.stops[0].why, 'you said culture')
    } finally {
      addCatalogPlaces('tokyo', [original])
    }
  })
})

describe('a trip about nights out', () => {
  const said: TripBrief = applyStory({ destination: 'tokyo', days: 3, travelers: 2, vibes: ['romantic'], story: { occasion: 'surprise date night', moments: [{ what: 'crazy date night', day: 1, when: 'night' }], feel: ['romantic', 'fun'] } })

  it('hears nightlife in a date night, a party or cocktails, unless they said no to it', () => {
    assert.ok(said.vibes.includes('nightlife'))
    assert.equal(said.rhythm, 0.75)
    assert.ok(applyStory({ vibes: [], story: { people: [{ who: 'friends', notes: 'into cocktails and dancing' }] } }).vibes.includes('nightlife'))
    assert.ok(!applyStory({ vibes: [], story: { feel: ['quiet', 'cosy'] } }).vibes.includes('nightlife'))
    assert.ok(!applyStory({ vibes: [], story: { occasion: 'date night', avoid: ['bars', 'clubs'] } }).vibes.includes('nightlife'))
  })

  it('deals drinks and food first, bars at the top, and parks and museums below them', () => {
    const city = tripCity(said)!
    const deck = laneDeck(city.places, said, { places: 28, food: 16 })
    const kinds = deck.map(c => city.places.find(p => p.id === c.id)!)
    assert.equal(laneOf(kinds[0]), 'food')
    const firstBar = kinds.findIndex(p => p.kind === 'bar')
    assert.ok(firstBar >= 0 && firstBar < 8, `first bar at ${firstBar}`)
    assert.ok(kindFit(city.places.find(p => p.kind === 'bar')!, said) > kindFit(city.places.find(p => p.kind === 'park')!, said))
  })

  it('leaves bars out when little ones are along, whatever the vibe', () => {
    const bar = tripCity(said)!.places.find(p => p.kind === 'bar')!
    assert.ok(kindFit(bar, { ...said, kids: 1 }) < kindFit(bar, said))
  })

  it('searches for nights out on their own, beside food and days', () => {
    assert.deepEqual(focusesOf(said).map(f => f.key), ['nights', 'eats', 'days'])
    assert.deepEqual(focusesOf({ vibes: ['history'], rhythm: 0.25 }).map(f => f.key), ['eats', 'days'])
  })

  it('keeps leading with places for a trip about sights', () => {
    const b: TripBrief = { destination: 'tokyo', days: 3, vibes: ['history', 'culture'] }
    const city = tripCity(b)!
    assert.equal(laneOf(city.places.find(p => p.id === laneDeck(city.places, b)[0].id)!), 'places')
  })
})
